# SmiRingDatabase — 開発ガイド

## 権限管理システム

### 概要

このシステムの権限管理は「認証（Authentication）」と「認可（Authorization）」の2層構造になっている。

- **認証**: ログイン済みかどうか（Supabase JWT）
- **認可**: ログイン済みユーザーが特定の機能を使えるかどうか（権限）

---

### DBスキーマ

```
permissions            … 権限の定義（開発者が作成する）
  id, name, resource, action, description, type, metadata

permission_mappings    … 誰に何の権限を与えるか
  grantee_type         … 'user' | 'role' | 'department' | 'group'
  grantee_id           … 上記それぞれのID
  permission_id        … permissions.id への参照

user_roles             … ロール定義（smiring_member, admin 等）
user_role_mappings     … ユーザー ↔ ロールの紐付け
departments            … 部署・チーム（親子構造あり）
member_department_mappings … ユーザー ↔ 部署の紐付け
groups                 … 汎用グループ（プロジェクト・共有チーム等）
user_group_mappings    … ユーザー ↔ グループの紐付け
```

権限はユーザーに **3経路** で付与できる：
1. 直接付与（grantee_type = 'user'）
2. ロール経由（grantee_type = 'role'）
3. 部署経由（grantee_type = 'department'）
4. 汎用グループ経由（grantee_type = 'group'）

実効権限は Supabase 関数 `get_user_permissions(user_id)` が4経路を UNION して返す。

---

### permissions.resource と action の命名規約

| resource | 意味 |
|---|---|
| `management` | 管理コンソール（ロール・部署・留学段階の管理） |
| `gallery` | 写真ギャラリー |
| `forms` | フォーム作成・回答・閲覧 |
| （今後追加） | 機能追加時に resource 名を決めてDBにレコードを追加する |

| action | 意味 | 包含関係 |
|---|---|---|
| `read` | 閲覧のみ | — |
| `write` | 追加・更新（閲覧も含む） | read を包含 |
| `delete` | 削除 | — |
| `admin` | 全操作 | read / write / delete を全て包含 |

**新しい権限を追加するときはコードを変更せず、DBにレコードを追加するだけでよい：**

```sql
INSERT INTO permissions (name, resource, action, description)
VALUES ('ギャラリー閲覧', 'gallery', 'read', 'ギャラリーの写真を閲覧できる');

-- ユーザーに直接付与する例
INSERT INTO permission_mappings (grantee_type, grantee_id, permission_id)
SELECT 'user', '<user_uuid>', id FROM permissions WHERE resource = 'gallery' AND action = 'read';

-- ロールに付与する例（そのロールを持つ全ユーザーに適用される）
INSERT INTO permission_mappings (grantee_type, grantee_id, permission_id)
SELECT 'role', '<role_uuid>', id FROM permissions WHERE resource = 'gallery' AND action = 'read';
```

---

### バックエンドの使い方

#### ミドルウェアの場所

```
backend/src/middleware/
  authenticate.ts       … JWT検証。req.user にユーザー情報をセットする
  requirePermission.ts  … 権限チェック。authenticate の後に使う
```

#### ルートへの適用パターン

```typescript
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';

// ログイン必須のみ（権限チェックなし）
router.get('/api/gallery', authenticate, handler);

// ログイン必須 + 権限チェック
router.get('/api/management/roles',  authenticate, requirePermission('management', 'read'),  handler);
router.post('/api/management/roles', authenticate, requirePermission('management', 'write'), handler);

// router.use でまとめて適用（managementRoutes のように全ルートが同じ権限を必要とする場合）
router.use(authenticate);
router.get('/roles',  requirePermission('management', 'read'),  handler);
router.post('/roles', requirePermission('management', 'write'), handler);
```

#### 権限の包含関係（requirePermission 内に組み込み済み）

- `admin` を持つユーザーは全 action を通す
- `write` を持つユーザーは `read` も通す（書けるなら読める）
- `read` を持つユーザーは `read` のみ通す

#### 新しいルートを追加するとき

1. `authenticate` を必ず付ける（全ルートログイン必須）
2. 権限で制御したい場合は `requirePermission('resource名', 'action')` を追加する
3. `resource` 名は上記の命名規約表を参照し、新機能なら新しい resource 名を決めてDBに権限レコードを追加する

---

### フロントエンドの使い方

#### 権限関連ファイルの場所

```
frontend/src/
  context/AuthContext.tsx          … ログイン時に権限を自動取得して保持
  hooks/usePermission.ts           … 権限チェック用フック
  components/ui/PermissionGate.tsx … 権限で表示/非表示を切り替えるラッパー
  App.tsx                          … RequirePermission コンポーネント（ルートガード）
```

#### UIの表示・非表示（PermissionGate）

権限がある場合だけ要素を表示したいとき：

```tsx
import PermissionGate from '../components/ui/PermissionGate';

// 権限がなければ何も表示しない
<PermissionGate resource="management" action="write">
  <DeleteButton />
</PermissionGate>

// 権限がなければ代替UIを表示する
<PermissionGate resource="management" action="write" fallback={<p>権限がありません</p>}>
  <EditForm />
</PermissionGate>
```

#### 条件分岐ロジックで権限チェック（usePermission）

ボタンの disabled 制御など、JSX 以外の場所で権限を使いたいとき：

```tsx
import { usePermission } from '../hooks/usePermission';

const canEdit = usePermission('gallery', 'write');

return <button disabled={!canEdit} onClick={handleEdit}>編集</button>;
```

#### ルートレベルのガード（RequirePermission）

URL直打ちでもアクセスを弾きたいとき（App.tsx に追加する）：

```tsx
// App.tsx の router 設定
{ path: '/management', element:
  <RequirePermission resource="management" action="read">
    <ManagementConsolePage />
  </RequirePermission>
}

// 権限がない場合は /home へリダイレクトされる
```

#### 権限の手動更新

管理者が権限を変更した直後に画面に反映させたい場合：

```tsx
const { refreshPermissions } = useAuth();
await refreshPermissions(); // GET /api/me/permissions を再取得する
```

---

### 新機能を追加するときのチェックリスト

#### バックエンド

- [ ] ルートに `authenticate` を付けた
- [ ] 権限制御が必要なら `requirePermission('resource', 'action')` を付けた
- [ ] 新 resource の場合、DBに `permissions` レコードを追加した

#### フロントエンド

- [ ] 権限によって表示・非表示を切り替える要素は `<PermissionGate>` で囲んだ
- [ ] URLで直接アクセスを弾きたいページは `<RequirePermission>` でラップした（App.tsx）
- [ ] ロジック内での判定は `usePermission` を使った

---

### Management Console（/management）

ロール・部署・留学段階の割り当てを管理するページ。

- アクセス条件: `management.read` 権限が必要
- 変更操作: `management.write` 権限が必要
- アプリ一覧（/apps）にも `management.read` がない場合はボタン自体が非表示になる

Management Console 自体で権限の付与・管理を行う想定のため、最初に開発者が自分のアカウントに直接権限を付与する必要がある（上記のSQL参照）。
