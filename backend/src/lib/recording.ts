import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import {
  DirectFileOutput,
  EgressClient,
  ParticipantInfo,
  RoomServiceClient,
  S3Upload,
  TrackSource,
} from 'livekit-server-sdk';
import { supabase } from './supabase';
import { r2, BUCKET_NAME } from './r2';

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

// Raw per-track files live under this prefix in the same bucket as everything else
// (`connect/recordings/` holds the finished videos), nested under `connect/` alongside
// the existing `connect/backgrounds/` per-feature convention. A separate bucket would buy
// nothing here: egress uploads with the same R2 credentials either way, and cleanup is a
// prefix-scoped listing (see cleanupStaleTempRecordings) rather than a bucket-wide
// lifecycle rule.
const TEMP_RECORDING_PREFIX = 'connect/recordings-tmp/';
const STALE_TEMP_RECORDING_MS = 24 * 60 * 60 * 1000;

/**
 * How many cameras a single recording will capture at once. Unset falls back to 20.
 *
 * Every recorded track is its own egress job — a separate handler process on the Hetzner
 * box, holding its own connection to the SFU — and measurement on that box put a video
 * track at roughly 0.06-0.11 of a core, a microphone at about half that. Crucially the
 * cost tracks the *number* of tracks and not their bitrate (track egress copies the codec
 * rather than re-encoding, so a 6 Mbps screen share and a 720p camera cost about the same),
 * which makes capping the count the only lever that scales with headcount.
 *
 * 20 is what the compositor can actually draw (`MAX_FACES_IN_GRID` in
 * recording-compositor/src/layout.ts) and what the live grid shows before it starts
 * scrolling (`MAX_LIVE_TILES`), so the cap can never cost the finished video a face it had
 * room for. Anyone past it is still in the recording: presence is tracked independently of
 * tracks (see `openParticipantPresence`), and the compositor gives a participant with no
 * camera their avatar tile — the same path someone who simply had their camera off takes.
 *
 * Microphones and screen shares are deliberately not capped. A dropped mic loses somebody's
 * voice for the whole call, and the screen share is usually the reason the call is being
 * recorded at all.
 */
const MAX_RECORDED_CAMERAS = Number(process.env.MAX_RECORDED_CAMERAS) || 20;
// const MAX_RECORDED_CAMERAS = 1;

// The Egress API is HTTP, but LIVEKIT_URL is the wss:// URL the clients use.
const egressClient =
  LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET
    ? new EgressClient(LIVEKIT_URL.replace(/^ws/, 'http'), LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    : null;

export function isRecordingConfigured(): boolean {
  return !!egressClient;
}

/** Recording id embedded in a temp file's key — see `buildTempRecordingKey`. */
function recordingIdFromTempKey(key: string): string | null {
  const rest = key.slice(TEMP_RECORDING_PREFIX.length);
  return rest.split('/')[1] ?? null;
}

/**
 * Which of these temp files' recordings must not be swept: still actively recording, or
 * sitting in `pending_review` waiting on someone to confirm or discard it. Everything else
 * (completed, failed, or no row at all — a crashed job's leftovers) is fair game.
 */
async function protectedRecordingIds(keys: string[]): Promise<Set<string>> {
  const ids = Array.from(new Set(keys.map(recordingIdFromTempKey).filter((id): id is string => !!id)));
  if (ids.length === 0) return new Set();
  const { data, error } = await supabase.from('connect_recordings').select('id, status').in('id', ids);
  if (error) {
    console.error('[Recording] Failed to check recording status before stale cleanup:', error);
    return new Set(ids); // Can't tell what's safe — protect everything rather than risk it.
  }
  return new Set((data ?? []).filter((r) => r.status === 'recording' || r.status === 'pending_review').map((r) => r.id));
}

/**
 * Deletes temp per-track files older than 24h. The compositor deletes its own inputs on
 * success, so anything still here this long after is a crashed or stuck Job execution —
 * this is the backstop for that, run periodically from the existing Maintenance API
 * (see maintenanceRoutes.ts's runHourlyTasks) rather than an R2 lifecycle rule, since the
 * app already has a scheduled task runner and this keeps recording cleanup alongside
 * everything else it manages.
 *
 * `pending_review` recordings are deliberately exempt from the 24h cutoff: unlike a crashed
 * job, someone deciding whether to keep a call is expected to take longer than a day
 * sometimes, and its files should only go away when they explicitly discard it
 * (`deleteTempRecordingFiles`) — not from this sweep running in the background.
 */
export async function cleanupStaleTempRecordings(): Promise<number> {
  const cutoff = Date.now() - STALE_TEMP_RECORDING_MS;
  let deletedCount = 0;
  let continuationToken: string | undefined;

  do {
    const response = await r2.send(
      new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: TEMP_RECORDING_PREFIX,
        ContinuationToken: continuationToken,
      }),
    );
    const stale = (response.Contents ?? []).filter(
      (o) => o.Key && o.LastModified && o.LastModified.getTime() < cutoff,
    );
    if (stale.length > 0) {
      const protectedIds = await protectedRecordingIds(stale.map((o) => o.Key!));
      const deletable = stale.filter((o) => {
        const id = recordingIdFromTempKey(o.Key!);
        return !id || !protectedIds.has(id);
      });
      if (deletable.length > 0) {
        await r2.send(
          new DeleteObjectsCommand({
            Bucket: BUCKET_NAME,
            Delete: { Objects: deletable.map((o) => ({ Key: o.Key! })) },
          }),
        );
        deletedCount += deletable.length;
      }
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  if (deletedCount > 0) {
    console.log(`[Recording] Cleaned up ${deletedCount} stale temp recording file(s)`);
  }
  return deletedCount;
}

/**
 * Deletes every temp per-track file for one recording — the discard path's cleanup. Run
 * immediately rather than waiting on `cleanupStaleTempRecordings`'s sweep, since a discarded
 * recording's files should disappear the moment the user asks for that, not a day later.
 */
export async function deleteTempRecordingFiles(roomId: string, recordingId: string): Promise<void> {
  const prefix = `${TEMP_RECORDING_PREFIX}${sanitizeKeyPart(roomId)}/${sanitizeKeyPart(recordingId)}/`;
  let continuationToken: string | undefined;

  do {
    const response = await r2.send(
      new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    const objects = (response.Contents ?? []).filter((o) => o.Key);
    if (objects.length > 0) {
      await r2.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET_NAME,
          Delete: { Objects: objects.map((o) => ({ Key: o.Key! })) },
        }),
      );
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
}

/** Metadata pointer written on the LiveKit room while a recording is running. */
export interface RecordingSession {
  recordingId: string;
  startedBy: string;
  startedAt: number;
}

export function sourceLabel(source: TrackSource): string {
  switch (source) {
    case TrackSource.CAMERA:
      return 'camera';
    case TrackSource.MICROPHONE:
      return 'microphone';
    case TrackSource.SCREEN_SHARE:
      return 'screen_share';
    case TrackSource.SCREEN_SHARE_AUDIO:
      return 'screen_share_audio';
    default:
      return 'unknown';
  }
}

/**
 * `__` separates the fields the compositor parses back out, so a single `_` must survive
 * untouched (LiveKit track ids are `TR_xxxx` / `AM_xxxx`) or the key's trackId stops
 * matching the unsanitized one stored in `connect_recording_tracks`, and every track looks
 * like it has no known start time. Only characters that could interfere with parsing (a
 * literal `/` breaking the path, or a second `_` risking a false `__` delimiter) get
 * replaced; everything else in a LiveKit id or a Supabase-generated identity is already
 * safe as-is.
 */
function sanitizeKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * Object key for one *visible stretch* of one track. Everything the compositor needs to
 * reassemble the call — who, which source, which publish, which stretch of it — is encoded
 * here rather than looked up later: `EgressInfo.fileResults[].filename` comes back empty for
 * track egress (livekit/egress#837), so the key we hand LiveKit is the only reliable link
 * between a file and its publisher.
 *
 * `segmentIndex` is what makes a camera toggled off and on produce two files rather than one
 * overwriting the other. The trackId alone can't: LiveKit mutes a camera instead of
 * unpublishing it (only screen share unpublishes), so the same trackId lives for the whole
 * call across any number of off/on cycles.
 *
 * Nested under the recording id, not just the room, because the compositor finds its inputs
 * by listing this prefix: anything else left in the same folder — a previous recording whose
 * cleanup didn't run, a crashed job's leftovers — would be picked up as part of *this*
 * recording and, having no row of its own to date it, dumped at the very start of the
 * timeline. Scoping the folder makes that impossible rather than merely unlikely.
 *
 * Deliberately extension-less: the container depends on the codec the publisher negotiated
 * (opus -> .ogg, h264 -> .mp4, vp8 -> .webm) and LiveKit appends the right one. The
 * compositor therefore discovers files by listing this prefix instead of assuming a name.
 */
export function buildTempRecordingKey(
  roomId: string,
  recordingId: string,
  identity: string,
  source: TrackSource,
  trackId: string,
  segmentIndex: number,
): string {
  return `${TEMP_RECORDING_PREFIX}${sanitizeKeyPart(roomId)}/${sanitizeKeyPart(recordingId)}/${sanitizeKeyPart(identity)}__${sourceLabel(source)}__${sanitizeKeyPart(trackId)}__${segmentIndex}`;
}

/**
 * R2 credentials travel with every request rather than sitting in the egress server's own
 * config: a global default there isn't reliably applied and jobs can silently fall back to
 * writing on the Hetzner box's local disk (livekit/egress#843).
 */
function buildTrackEgressOutput(key: string): DirectFileOutput {
  return new DirectFileOutput({
    filepath: key,
    // The compositor identifies files by the key we chose above, not LiveKit's own
    // manifest — skip writing one so it doesn't clutter the temp prefix's listing.
    disableManifest: true,
    output: {
      case: 's3',
      value: new S3Upload({
        accessKey: process.env.R2_ACCESS_KEY_ID!,
        secret: process.env.R2_SECRET_ACCESS_KEY!,
        endpoint: process.env.R2_ENDPOINT!,
        bucket: BUCKET_NAME,
        region: 'auto',
        forcePathStyle: true,
      }),
    },
  });
}

/**
 * How many cameras this recording currently has an egress running for.
 *
 * Counted from the open rows rather than kept as a separate tally, because those rows are
 * already the source of truth for "is this being recorded right now" (`syncCameraRecordings`
 * reads the same ones), so this cannot drift away from what is actually running.
 */
async function openCameraCount(recordingId: string): Promise<number> {
  const { count, error } = await supabase
    .from('connect_recording_tracks')
    .select('id', { count: 'exact', head: true })
    .eq('recording_id', recordingId)
    .eq('source', 'camera')
    .is('ended_at', null);
  if (error) {
    // Recording one camera too many is a far better failure than silently dropping one
    // because a count query happened to fail.
    console.error(`[Recording] Failed to count open cameras for ${recordingId}:`, error);
    return 0;
  }
  return count ?? 0;
}

/**
 * Starts recording one published track. Returns false if LiveKit rejected it.
 *
 * Also records the moment recording actually began for this track in our own DB
 * (`connect_recording_tracks`), rather than leaving the compositor to reconstruct it later
 * from LiveKit's `listEgress` — in practice that came back without a start time for
 * tracks added mid-recording, traced since to a key-sanitization bug on our own side
 * (trackIds contain `_`, which was being rewritten to `-`), not an unreliable API. Still,
 * writing it ourselves removes the dependency on that lookup entirely.
 *
 * The timestamp is captured *before* calling startTrackEgress, not after it resolves:
 * `startTrackEgress` is a round trip to the Hetzner box, and its latency varies per call
 * (tens to a few hundred ms) — timestamping on the response would bake that jitter into
 * offsetMs, so two tracks started in the same `Promise.all` batch (e.g. everyone already
 * in the room when recording begins) could end up looking like they started noticeably
 * apart even though the request was fired for both at the same instant.
 */
export async function startTrackRecording(
  roomId: string,
  recordingId: string,
  identity: string,
  source: TrackSource,
  trackId: string,
): Promise<boolean> {
  if (!egressClient) return false;

  // Cameras are capped, mics and screen shares are not (see `MAX_RECORDED_CAMERAS`). This
  // check covers the two paths that add one camera at a time: `syncCameraRecordings`, which
  // awaits each start in turn, and the `track_published` webhook. It cannot catch the batch
  // fired when a recording starts — every caller in that `Promise.all` reads the same count
  // before any of them has inserted — so `startRecordingForParticipants` trims its own list
  // up front instead.
  //
  // Two webhooks arriving together can still both pass and land on cap + 1. That is left
  // alone: one extra camera costs a fraction of a core, while the failure this function
  // really has to prevent — several egresses on one track — is still held by the partial
  // unique index on the insert below.
  if (source === TrackSource.CAMERA && (await openCameraCount(recordingId)) >= MAX_RECORDED_CAMERAS) {
    console.log(
      `[Recording] Not starting camera ${trackId} for ${identity}: ` +
        `already recording ${MAX_RECORDED_CAMERAS} cameras — they will show as an avatar tile`,
    );
    return false;
  }

  // The row is claimed *before* the egress is started, because inserting it is what makes
  // this safe to call concurrently: a partial unique index allows only one un-ended row per
  // track, so of several callers racing to record the same camera (two `/sync` pings, or a
  // ping arriving alongside the `track_published` webhook) exactly one gets past this point.
  // Starting first and inserting after would leave the losers' egresses running unrecorded,
  // which is how one camera ended up with several overlapping recordings of itself.
  const segmentIndex = await nextSegmentIndex(recordingId, trackId);
  const requestedAt = new Date();
  const { data: claimed, error: claimError } = await supabase
    .from('connect_recording_tracks')
    .insert({
      recording_id: recordingId,
      track_id: trackId,
      segment_index: segmentIndex,
      identity,
      source: sourceLabel(source),
      started_at: requestedAt.toISOString(),
    })
    .select('id')
    .single();
  if (claimError || !claimed) {
    // Expected whenever two callers race — the other one is already recording this track.
    console.log(`[Recording] Not starting ${trackId}: already being recorded (${claimError?.code})`);
    return false;
  }

  try {
    const key = buildTempRecordingKey(roomId, recordingId, identity, source, trackId, segmentIndex);
    const egress = await egressClient.startTrackEgress(roomId, buildTrackEgressOutput(key), trackId);
    // Kept so this egress can be stopped by id. Searching `listEgress` by trackId instead
    // stops only the first match, which silently left duplicates running to the end of the
    // call, each writing a file the compositor then had to choose between.
    await supabase
      .from('connect_recording_tracks')
      .update({ egress_id: egress.egressId })
      .eq('id', claimed.id);
    return true;
  } catch (error: any) {
    console.error(`[Recording] startTrackEgress failed (${roomId}/${identity}/${trackId}):`, error?.message);
    // Release the claim, or nothing would ever record this track again for this recording.
    await supabase.from('connect_recording_tracks').delete().eq('id', claimed.id);
    return false;
  }
}

/** Next free segment number for this track, so a re-recorded camera gets its own file. */
async function nextSegmentIndex(recordingId: string, trackId: string): Promise<number> {
  const { data, error } = await supabase
    .from('connect_recording_tracks')
    .select('segment_index')
    .eq('recording_id', recordingId)
    .eq('track_id', trackId)
    .order('segment_index', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(`[Recording] Failed to read segment index for ${trackId}:`, error);
    return 0;
  }
  return data ? data.segment_index + 1 : 0;
}

/**
 * Stops the egress for one track and closes its open row.
 *
 * The egress id comes from LiveKit rather than our own bookkeeping, for the same reason
 * `stopActiveEgresses` asks: it can't go stale, and it can't miss one we forgot to record.
 */
export async function stopTrackRecording(
  roomId: string,
  recordingId: string,
  trackId: string,
): Promise<void> {
  const { data: open } = await supabase
    .from('connect_recording_tracks')
    .select('id, egress_id')
    .eq('recording_id', recordingId)
    .eq('track_id', trackId)
    .is('ended_at', null)
    .maybeSingle();

  if (egressClient && open?.egress_id) {
    try {
      await egressClient.stopEgress(open.egress_id);
    } catch (error: any) {
      // Already finished on its own (the publisher left, the track was unpublished) — the
      // row still needs closing either way.
      console.warn(`[Recording] Failed to stop egress ${open.egress_id}:`, error?.message);
    }
  } else if (egressClient) {
    // No id recorded (a row from before egress ids were stored, or a failed update). Falling
    // back to a search stops at most one egress for this track, so this is best-effort.
    try {
      const active = await egressClient.listEgress({ roomName: roomId, active: true });
      const match = active.find((e) => e.request.case === 'track' && e.request.value.trackId === trackId);
      if (match) await egressClient.stopEgress(match.egressId);
      else console.warn(`[Recording] No egress id and no active egress found for track ${trackId}`);
    } catch (error: any) {
      console.warn(`[Recording] Failed to stop egress for track ${trackId}:`, error?.message);
    }
  }

  const { error } = await supabase
    .from('connect_recording_tracks')
    .update({ ended_at: new Date().toISOString() })
    .eq('recording_id', recordingId)
    .eq('track_id', trackId)
    .is('ended_at', null);
  if (error) console.error(`[Recording] Failed to close track row for ${trackId}:`, error);
}

/** True if a camera track is currently muted — the only source whose mute we act on. */
function isMutedCamera(track: { source: TrackSource; muted: boolean }): boolean {
  return track.source === TrackSource.CAMERA && track.muted;
}

/**
 * Starts recording every track currently published in the room. Returns how many started.
 *
 * A muted camera is deliberately skipped. Its publication is still there (LiveKit mutes
 * cameras rather than unpublishing them), but no frames are flowing, and an egress started
 * on a silent track anchors its file's first frame to whenever the camera comes back —
 * which we'd then have already timestamped as "the moment recording began", placing footage
 * from minutes later at the very start of the video. `syncCameraRecordings` starts it for
 * real when the camera comes back on.
 *
 * A muted *microphone* is not skipped: LiveKit leaves the mic track running and merely
 * disables it (`stopMicTrackOnMute` is false by default), so silence keeps flowing and the
 * file's timeline stays honest.
 *
 * Cameras past `MAX_RECORDED_CAMERAS` are dropped here rather than by `startTrackRecording`'s
 * own cap, which this one batch is the only thing that can slip past — see below.
 */
export async function startRecordingForParticipants(
  roomId: string,
  recordingId: string,
  participants: ParticipantInfo[],
): Promise<{ attempted: number; started: number }> {
  const candidates = participants.flatMap((participant) =>
    participant.tracks.filter((track) => !isMutedCamera(track)).map((track) => ({ participant, track })),
  );

  // The cap has to be applied to the list, not per start: these all go out in one
  // `Promise.all`, so every call would read the same "nothing recording yet" count and every
  // one would be let through. Ordering by join time decides it deterministically — whoever
  // was in the room first keeps their slot — rather than leaving it to however LiveKit
  // happened to order the participant list. Mics and screen shares bypass this entirely.
  const cameras = candidates
    .filter(({ track }) => track.source === TrackSource.CAMERA)
    .sort((a, b) => Number(a.participant.joinedAt - b.participant.joinedAt))
    .slice(0, MAX_RECORDED_CAMERAS);
  const skipped = candidates.filter(({ track }) => track.source === TrackSource.CAMERA).length - cameras.length;
  if (skipped > 0) {
    console.log(
      `[Recording] Recording ${cameras.length} of ${cameras.length + skipped} cameras ` +
        `(cap ${MAX_RECORDED_CAMERAS}) — the other ${skipped} will show as avatar tiles`,
    );
  }

  const startable = [...cameras, ...candidates.filter(({ track }) => track.source !== TrackSource.CAMERA)];
  const results = await Promise.all(
    startable.map(({ participant, track }) =>
      startTrackRecording(roomId, recordingId, participant.identity, track.source, track.sid),
    ),
  );
  return { attempted: startable.length, started: results.filter(Boolean).length };
}

/**
 * Brings the running egresses in line with LiveKit's current camera mute state.
 *
 * This exists because muting a camera is invisible to webhooks: `track_published` fires only
 * on the first real publish of a session, and there is no `track_muted`/`track_unmuted`
 * webhook at all. Clients therefore poke `/recording/sync` after toggling their camera — but
 * nothing they send is trusted. The state read here comes from LiveKit, and every timestamp
 * is this server's own clock at the moment it starts the egress, exactly as on the
 * `track_published` path.
 *
 * The open/closed rows in `connect_recording_tracks` *are* the "is this being recorded right
 * now" state, so no separate bookkeeping can drift out of sync with them.
 */
export async function syncCameraRecordings(
  roomId: string,
  recordingId: string,
  participants: ParticipantInfo[],
): Promise<void> {
  const { data: openRows, error } = await supabase
    .from('connect_recording_tracks')
    .select('track_id')
    .eq('recording_id', recordingId)
    .is('ended_at', null);
  if (error) {
    console.error(`[Recording] Failed to read open track rows for ${recordingId}:`, error);
    return;
  }
  const recording = new Set((openRows ?? []).map((row) => row.track_id));

  for (const participant of participants) {
    for (const track of participant.tracks) {
      if (track.source !== TrackSource.CAMERA) continue;
      const isRecording = recording.has(track.sid);

      if (track.muted && isRecording) {
        console.log(`[Recording] Camera off for ${participant.identity} — closing segment`);
        await stopTrackRecording(roomId, recordingId, track.sid);
      } else if (!track.muted && !isRecording) {
        console.log(`[Recording] Camera on for ${participant.identity} — starting segment`);
        await startTrackRecording(roomId, recordingId, participant.identity, track.source, track.sid);
      }
    }
  }
}

/** Records that these people were in the room from now on. Ignores anyone already open. */
export async function openParticipantPresence(recordingId: string, identities: string[]): Promise<void> {
  if (identities.length === 0) return;
  const { error } = await supabase.from('connect_recording_participants').insert(
    identities.map((identity) => ({ recording_id: recordingId, identity })),
  );
  if (error) console.error(`[Recording] Failed to open presence rows for ${recordingId}:`, error);
}

/**
 * Closes every still-open track and presence interval for a finished recording.
 *
 * Purely hygiene for the backend's own state — the compositor measures each file's length
 * from the file itself and clamps presence to the recording — but leaving rows open would
 * make `syncCameraRecordings` believe egresses are still running if the same recording id
 * were ever seen again.
 */
async function closeOpenIntervals(recordingId: string): Promise<void> {
  const endedAt = new Date().toISOString();
  const [tracks, participants] = await Promise.all([
    supabase
      .from('connect_recording_tracks')
      .update({ ended_at: endedAt })
      .eq('recording_id', recordingId)
      .is('ended_at', null),
    supabase
      .from('connect_recording_participants')
      .update({ left_at: endedAt })
      .eq('recording_id', recordingId)
      .is('left_at', null),
  ]);
  if (tracks.error) console.error('[Recording] Failed to close open track rows:', tracks.error);
  if (participants.error) console.error('[Recording] Failed to close open presence rows:', participants.error);
}

/**
 * Closes every track interval this participant still had open, for when they leave the room.
 *
 * Their egresses have already ended on their own — LiveKit tears a track egress down when
 * the track goes away with its publisher — but nothing was closing our *rows*. The only
 * other path that closes one (`syncCameraRecordings`) walks `listParticipants()`, and
 * someone who has left is no longer in it, so their rows stayed open until the recording
 * itself finished.
 *
 * That was harmless while nothing read them mid-recording. It stopped being harmless once
 * cameras became capped: `openCameraCount` counts exactly these rows, so twenty people
 * being recorded and then leaving would hold the cap full for the rest of the call, and
 * everyone still in the room — however few — would be stuck as avatar tiles with a box that
 * had all the capacity in the world.
 *
 * Closing them here also makes `ended_at` mean what it says. The compositor's
 * `clampToEgressLifetime` compares it against how much media a file actually holds, and
 * "the moment the whole recording stopped" was never the right answer for someone who left
 * an hour earlier.
 */
export async function closeParticipantTracks(recordingId: string, identity: string): Promise<void> {
  const { data: open, error } = await supabase
    .from('connect_recording_tracks')
    .select('id, egress_id')
    .eq('recording_id', recordingId)
    .eq('identity', identity)
    .is('ended_at', null);
  if (error) {
    console.error(`[Recording] Failed to read open tracks for departing ${identity}:`, error);
    return;
  }
  if (!open || open.length === 0) return;

  // Best effort. The egress has almost certainly stopped itself already, so this usually
  // just warns — but one that somehow outlived its publisher would otherwise keep writing
  // until the call ends, which is the failure that put segment_index and egress ids in this
  // table in the first place.
  if (egressClient) {
    await Promise.all(
      open
        .filter((row) => row.egress_id)
        .map((row) =>
          egressClient!
            .stopEgress(row.egress_id!)
            .catch((e: any) =>
              console.warn(
                `[Recording] Egress ${row.egress_id} for departed ${identity} was already done:`,
                e?.message,
              ),
            ),
        ),
    );
  }

  const { error: closeError } = await supabase
    .from('connect_recording_tracks')
    .update({ ended_at: new Date().toISOString() })
    .in(
      'id',
      open.map((row) => row.id),
    );
  if (closeError) {
    console.error(`[Recording] Failed to close track rows for departed ${identity}:`, closeError);
    return;
  }
  console.log(`[Recording] Closed ${open.length} open track(s) for departed ${identity}`);
}

/** Closes one person's open presence interval. */
export async function closeParticipantPresence(recordingId: string, identity: string): Promise<void> {
  const { error } = await supabase
    .from('connect_recording_participants')
    .update({ left_at: new Date().toISOString() })
    .eq('recording_id', recordingId)
    .eq('identity', identity)
    .is('left_at', null);
  if (error) console.error(`[Recording] Failed to close presence for ${identity}:`, error);
}

/**
 * Stops every egress LiveKit still reports as running for this room.
 *
 * Asking LiveKit rather than replaying a list we stored ourselves is what keeps stop
 * correct: tracks started after the recording began (a late joiner, a camera switched on)
 * are included without any bookkeeping, and a stale entry can't leave an egress running.
 */
export async function stopActiveEgresses(roomId: string): Promise<number> {
  if (!egressClient) return 0;
  try {
    const active = await egressClient.listEgress({ roomName: roomId, active: true });
    const results = await Promise.all(
      active.map((egress) =>
        egressClient!
          .stopEgress(egress.egressId)
          .then(() => true)
          .catch((e) => {
            // Already finished on its own (publisher left, track unpublished) — not an error.
            console.warn(`[Recording] stopEgress ${egress.egressId} failed:`, e?.message);
            return false;
          }),
      ),
    );
    return results.filter(Boolean).length;
  } catch (error: any) {
    console.error(`[Recording] listEgress failed for ${roomId}:`, error?.message);
    return 0;
  }
}

function parseRoomMetadata(metadata: string | undefined): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The active recording session for a room, or null.
 *
 * Room metadata holds only this pointer — never the list of running egresses, which
 * `stopActiveEgresses` gets from LiveKit instead. That split is what makes concurrent
 * writes harmless: two "start" clicks race to write the same kind of pointer, and stop
 * still catches every egress either of them started.
 */
export async function getRecordingSession(
  roomService: RoomServiceClient,
  roomId: string,
): Promise<RecordingSession | null> {
  const rooms = await roomService.listRooms([roomId]);
  const room = rooms.find((r) => r.name === roomId);
  if (!room) return null;
  const session = parseRoomMetadata(room.metadata).recording;
  return session ? (session as RecordingSession) : null;
}

/** Writes (or clears, with null) the recording pointer, preserving any other metadata keys. */
export async function setRecordingSession(
  roomService: RoomServiceClient,
  roomId: string,
  session: RecordingSession | null,
): Promise<void> {
  const rooms = await roomService.listRooms([roomId]);
  const room = rooms.find((r) => r.name === roomId);
  const metadata = parseRoomMetadata(room?.metadata);

  if (session) {
    metadata.recording = session;
  } else {
    delete metadata.recording;
  }
  await roomService.updateRoomMetadata(roomId, JSON.stringify(metadata));
}

/**
 * The id of the recording currently running for a room, from the database rather than the
 * room's metadata.
 *
 * Stopping can't read the metadata pointer: by the time `room_finished` arrives the room
 * is gone from LiveKit and its metadata with it, which would strand exactly the recordings
 * the end-of-call path exists to rescue.
 */
export async function getActiveRecordingId(roomId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('connect_recordings')
    .select('id')
    .eq('room_id', roomId)
    .eq('status', 'recording')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(`[Recording] Failed to look up active recording for ${roomId}:`, error);
    return null;
  }
  return data?.id ?? null;
}

/**
 * Ends a recording: stop the egresses, drop the room pointer, and leave it in
 * `pending_review` — temp files kept, compositor not yet started. Shared by the explicit
 * stop route (`stoppedBy` is whoever pressed it) and the webhook's end-of-call safety net
 * (`stoppedBy` is null — nobody pressed stop, the call just ended), so a host who never
 * presses stop still gets a recording they can come back to. Someone still has to confirm
 * it from the recordings list before it's actually composited (`POST .../confirm` in
 * connectRoutes.ts), or discard it (`POST .../discard`).
 */
export async function finishRecording(
  roomService: RoomServiceClient,
  roomId: string,
  recordingId: string,
  stoppedBy: string | null,
): Promise<void> {
  await stopActiveEgresses(roomId);
  await closeOpenIntervals(recordingId);

  await setRecordingSession(roomService, roomId, null).catch((e) =>
    // Expected on the end-of-call path: the room is already gone, and the pointer with it.
    console.warn(`[Recording] Failed to clear recording metadata on ${roomId}:`, e?.message),
  );

  // Guarded on the current status so a stop racing the end-of-call webhook can't stomp on
  // whichever of them got here first.
  const { error } = await supabase
    .from('connect_recordings')
    .update({ status: 'pending_review', stopped_by: stoppedBy })
    .eq('id', recordingId)
    .eq('status', 'recording');
  if (error) console.error('[Recording] Failed to mark recording as pending_review:', error);
}
