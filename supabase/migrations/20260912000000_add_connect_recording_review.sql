-- 録画停止後に確認ダイアログ（保存/破棄・タイトル入力）を挟むためのカラム追加。
--
-- status の遷移が一段増える: recording -> pending_review -> processing -> completed / failed
--   pending_review … 停止済み・一時ファイル（connect/recordings-tmp/ 配下）は保持したまま、
--                     保存/破棄の確認待ち。Cloud Run Job（compositor）はまだ起動しない。
--                     confirm で processing に進み、discard で一時ファイルごと削除される
--                     （backend/src/routes/connectRoutes.ts の /recordings/:id/confirm,
--                     /recordings/:id/discard を参照）。
--
-- pending_review の間、この録画は開始者(started_by)または停止者(stopped_by)にしか見えない
-- （GET /api/connect/recordings, GET /api/connect/recordings/:id 参照）。stopped_by は
-- 明示的に停止ボタンを押した人（ホストなら誰でも停止できる）。押されないまま通話が終了した
-- 場合（webhookの安全網経由）は null のままで、started_by だけが見える。

ALTER TABLE public.connect_recordings
    ADD COLUMN stopped_by text,
    ADD COLUMN title text;
