# Mot · Flash cards

Next.js App Router + React, triển khai trên Vercel; Google OAuth bằng NextAuth/Auth.js; dữ liệu riêng từng tài khoản trong Cloudflare D1 (SQLite). Không còn Supabase hay chế độ tự động lưu từ vựng vào local storage.

## Kiến trúc

```text
Browser -> Next.js trên Vercel -> Cloudflare D1 REST API
					|
					+-> Google OAuth -> phiên JWT HttpOnly (7 ngày)
```

Browser chỉ gọi API cùng origin. Server lấy owner_id từ phiên đăng nhập, kiểm tra ALLOWED_EMAILS ở mọi request, và dùng SQL có tham số. D1 token không đi xuống client. Mỗi thao tác lưu từ và category là một batch transaction; không tự retry thao tác ghi khi mất kết nối.

Vercel Hobby phù hợp dự án cá nhân, phi thương mại. Google OAuth cơ bản và NextAuth không thu phí đăng nhập. D1 Free có hạn mức đọc/ghi/lưu trữ; vượt hạn mức có thể làm app tạm thời không truy vấn được. Không bật gói trả phí hoặc add-on trả phí nếu mục tiêu là 0 đồng. REST API Cloudflare còn có rate limit riêng, nên phương án này dành cho app cá nhân/nhóm nhỏ, không phải import khối lượng lớn đồng thời.

## 1. Chạy local

Yêu cầu Node.js 24 LTS (tối thiểu 22.13).

```sh
npm ci
```

Tạo `.env.local` theo [`.env.example`](.env.example). Không commit file này. Tất cả biến dưới đây chỉ dùng trên server, không có tiền tố `NEXT_PUBLIC_`:

| Biến | Giá trị |
| --- | --- |
| `NEXTAUTH_URL` | `http://localhost:3000` khi chạy local; URL HTTPS chính thức trên Vercel khi deploy |
| `NEXTAUTH_SECRET` | Chuỗi ngẫu nhiên đủ mạnh, giữ ổn định giữa các lần deploy |
| `GOOGLE_CLIENT_ID` | OAuth Web client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `ALLOWED_EMAILS` | Email được đăng nhập, phân cách bằng dấu phẩy; rỗng hoặc `*` không mở truy cập |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID từ Cloudflare |
| `CLOUDFLARE_DATABASE_ID` | ID database D1 |
| `CLOUDFLARE_D1_TOKEN` | API token giới hạn đúng account với quyền D1 đọc/ghi |

Tự tạo secret trong terminal riêng của bạn, không gửi vào chat:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

```sh
npm run dev
```

Mở http://localhost:3000. Khi chưa cấu hình đủ, trang vẫn chạy nhưng nút đăng nhập bị khóa; không dùng dữ liệu local làm fallback. Local app mặc định kết nối D1 từ xa qua API; nên dùng một D1 riêng cho development.

## 2. Tạo Cloudflare D1

1. Tạo tài khoản Cloudflare Free. Trong dashboard mở Workers & Pages > D1, tạo database `mot-flashcards`, hoặc chạy:

	```sh
	npx wrangler login
	npx wrangler d1 create mot-flashcards
	```

2. Thay UUID mẫu trong [`wrangler.jsonc`](wrangler.jsonc) bằng database ID thật. Đặt cùng ID trong `.env.local`.
3. Chạy migration trên database đích:

	```sh
	npm run db:migrate
	```

4. Tạo API token Cloudflare có quyền D1 Write/Edit cho đúng account. Lưu token vào `CLOUDFLARE_D1_TOKEN`. Không dùng Global API Key.

Có thể kiểm tra schema với D1 local bằng `npm run db:migrate:local`; lệnh này không làm app tự chuyển sang database local. Không cần triển khai Cloudflare Worker: Next.js gọi D1 REST API trực tiếp từ server.

### Schema

Migration: [`cloudflare/migrations/0001_initial.sql`](cloudflare/migrations/0001_initial.sql).

| Bảng | Các cột / vai trò chính |
| --- | --- |
| `users` | `id` UUID nội bộ, `google_sub` duy nhất, `email`, `name`, `created_at`; không lưu mật khẩu |
| `vocabularies` | `id`, `owner_id`, `word`, `pronunciation`, `part_of_speech`, `meaning`, `example`, `read_text`, `language`, `created_at`, `updated_at` |
| `categories` | `id`, `owner_id`, `name`; tên nhóm duy nhất trong một tài khoản |
| `vocabulary_categories` | `owner_id`, `vocabulary_id`, `category_id`; quan hệ nhiều-nhiều, khóa ngoại ghép ngăn gán chéo tài khoản |
| `user_settings` | `owner_id`, `front_delay`, `back_delay` (1-10 giây), `auto_speak` (0/1) |
| `seed_imports` | `(owner_id, seed_key)` duy nhất; ghi nhận đã nhập bộ CSV mẫu |

Xóa user sẽ cascade dữ liệu của user đó. Xóa từ chỉ xóa các liên kết nhóm của từ. Không đặt unique trên `(word, language)` vì app vẫn cho phép thêm một bản riêng khi import.

### CSV thành dữ liệu bảng

CSV gốc: [`data/Mots_nouveaux_Lecon_1_v2.csv`](data/Mots_nouveaux_Lecon_1_v2.csv), gồm **21 dòng từ vựng**.

| Cột CSV | Cột `vocabularies` |
| --- | --- |
| Từ gốc | `word` |
| Phiên âm | `pronunciation` |
| Loại từ/Giống | `part_of_speech` |
| Nghĩa | `meaning` |
| Ví dụ đơn giản | `example` |

Mặc định `language = fr-FR`, `read_text = ''`, nhóm `Leçon 1`. Giữ nguyên Unicode, IPA, dấu nháy và dấu phẩy trong ô CSV. Không cố tách cột loại từ/giống thành enum vì nguồn có nhiều dạng kết hợp.

**Lần đăng nhập đầu tiên:** tạo user và seed 21 từ riêng cho tài khoản đó. Seed lặp lại không nhân đôi, không ghi đè từ đã sửa và không phục hồi từ đã xóa. Seed dùng cùng batch với dấu đánh dấu `seed_imports`.

**Xuất SQL thủ công:** lấy `users.id` trong D1, rồi chạy:

```sh
npm run db:seed:sql -- --owner USER_ID --output data/lesson-1.sql
npx wrangler d1 execute mot-flashcards --remote --file data/lesson-1.sql
```

Lệnh xuất chỉ tạo file, không kết nối cloud và không ghi đè file đã tồn tại. Tài khoản đích phải có trong `users`. Nếu đã seed tự động, SQL này là no-op. Muốn thêm bài học khác, dùng import CSV/XLSX trong app; đừng xóa seed marker để chạy lại trên dữ liệu đang dùng.

## 3. Cấu hình Google OAuth

1. Tạo project trong Google Cloud Console, mở Google Auth Platform và cấu hình Branding/Audience. Chỉ cần scope `openid`, `email`, `profile`; không cần Identity Platform trả phí.
2. Nếu app đang ở chế độ Testing, thêm email của bạn vào Test users. Việc này độc lập với allowlist của app: email phải được cả Google lẫn app cho phép.
3. Tạo OAuth Client ID kiểu **Web application**. Thêm redirect URI chính xác:

	```text
	http://localhost:3000/api/auth/callback/google
	https://YOUR-PROJECT.vercel.app/api/auth/callback/google
	```

4. Lưu client ID/secret vào môi trường tương ứng. Google phải trả `email_verified = true`; định danh ổn định của tài khoản là `google_sub`, không phải tên hiển thị.
5. Đặt email của bạn vào `ALLOWED_EMAILS`. Sau này thêm email khác bằng dấu phẩy và redeploy; mỗi người tự có bộ từ và cài đặt riêng.

Nếu đổi cổng local, phải đổi cả `NEXTAUTH_URL` lẫn redirect URI Google. Nếu mở cho người dùng ngoài Test users, hoàn tất cấu hình xuất bản consent screen theo yêu cầu Google.

## 4. Deploy Vercel

1. Import repository trên Vercel, chọn framework **Next.js**, Node.js 24.x và gói Hobby cho dự án cá nhân.
2. Thêm đủ biến trong `.env.example` vào môi trường **Production**. `NEXTAUTH_URL` phải là origin chính thức, không có đường dẫn phụ.
3. Chạy D1 migration trước khi đăng nhập lần đầu. Deploy bằng build command `npm run build`; để Vercel tự nhận output Next.js.
4. Thêm URL callback production trong Google OAuth rồi đăng nhập bằng email được phép. Kiểm tra thư viện có 21 từ và nhóm `Leçon 1`.

Không dùng GitHub Pages: app cần server để chạy OAuth và API. Workflow trong [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) chỉ test/build; Vercel Git integration chịu trách nhiệm deploy. Không đặt production secret vào Preview deployment tùy ý; dùng môi trường/DB development riêng với callback URL ổn định nếu cần kiểm thử đăng nhập Preview.

## Dữ liệu cũ và sử dụng

- Dữ liệu local cũ không bị xóa. Tại **Nhập tệp > Nhập dữ liệu thiết bị**, dữ liệu cùng origin được đưa vào preview để bạn chọn cách nhập lên cloud. Không tự chuyển cài đặt cũ.
- Nếu chuyển từ GitHub Pages sang Vercel, local storage thuộc origin cũ không đọc được ở origin mới. Xuất CSV tại origin cũ hoặc chạy đoạn sau trong DevTools của trang cũ, rồi nhập file ở trang mới:

  ```js
  const saved = JSON.parse(localStorage.getItem('mot-flashcards-v1') || '{}')
  const rows = [['Từ gốc', 'Phiên âm', 'Loại từ/Giống', 'Nghĩa', 'Ví dụ đơn giản', 'Văn bản đọc', 'Category', 'Ngôn ngữ'],
	 ...(saved.words || []).map(word => [word.word, word.pronunciation, word.part_of_speech, word.meaning, word.example, word.read_text,
		(word.categories || []).map(category => typeof category === 'string' ? category : category.name).join(';'), word.language])]
	const csv = '\uFEFF' + rows.map(row => row.map(value => {
		const text = String(value ?? '')
		const safe = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(text) ? "'" + text : text
		return '"' + safe.replaceAll('"', '""') + '"'
	}).join(',')).join('\r\n')
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  link.download = 'mot-backup.csv'
  link.click()
  ```

- Nếu trước đây đã dùng Supabase cloud, cần export dữ liệu tài khoản đó sang CSV rồi import. Không tự chuyển user/password từ Supabase sang Google.
- Import CSV UTF-8/XLSX tối đa 20 MB và 10.000 dòng; preview phân trang 50 dòng. Chọn sheet, ánh xạ cột, sửa từ/nghĩa hoặc bỏ chọn dòng trước khi xác nhận.
- Từ trùng theo word/language: cập nhật, bỏ qua hoặc thêm riêng. Cột không ánh xạ giữ nguyên; cột ánh xạ để trống xóa giá trị cũ. Giới hạn mỗi từ 20 nhóm, mỗi tên nhóm tối đa 100 ký tự.
- Mỗi dòng import là một transaction riêng. Nếu cloud lỗi, dừng nhập và giữ các dòng đã hoàn thành; không hoàn tác cả file. Khi mất phản hồi mạng, tải lại dữ liệu để kiểm tra trước khi nhập lại.
- Chi tiết từ cho sửa nghĩa, ví dụ, nhóm; xóa cần xác nhận. Nút tải xuống ở thư viện xuất CSV để sao lưu.
- CSV xuất thêm dấu nháy đơn vào ô có dạng công thức để spreadsheet không thực thi. Database không đổi; khi nhập lại những ô này, dấu nháy bảo vệ được giữ nguyên.
- API tải thư viện theo trang tối đa 25 từ, giới hạn kích thước response D1/Vercel. App tải đủ trang rồi mới mở ôn tập.
- Lật thẻ và ôn tự động chạy trong trình duyệt, không gọi D1 mỗi lần lật. Ôn tự động dừng khi đổi thao tác hoặc ẩn tab. Giọng đọc phụ thuộc thiết bị; lựa chọn giọng vẫn lưu local.
- Đồng bộ là tải khi mở trang và lưu khi thao tác, không phải realtime giữa các tab. Mở lại/tải lại trang trên thiết bị khác để nhận dữ liệu mới; chỉnh sửa đồng thời cùng từ áp dụng lần lưu cuối.

## Kiểm thử

```sh
npm test
npm run build
```

Test chạy không cần secret: SQLite thật để kiểm tra schema/transaction/seed/quyền sở hữu, test D1 transport/API security và React với API mock. OAuth Google và D1 từ xa cần được smoke-test sau khi cấu hình tài khoản thật. SQLite của Node có thể in cảnh báo experimental, không phải lỗi test.

Nếu npm trên Windows báo `spawn EPERM` trước khi chạy script, có thể gọi trực tiếp cùng công cụ, không cần nâng quyền hệ thống:

```sh
node --max-old-space-size=256 --import tsx --test --test-timeout=10000 test/core.test.js test/database.test.js test/main.test.js test/server.test.js
node node_modules/next/dist/bin/next build
```
