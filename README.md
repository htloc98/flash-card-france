# Mot · Flash cards

Responsive French vocabulary flashcards with CSV/Excel import, optional speech, and Supabase account sync. Without Supabase configuration, the app works in local-only mode and stores its data in this Browser.

## Run locally

```sh
npm ci
npm run dev
```

Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to enable account sign-in and sync. The anon key is intended for browser use; never put a Supabase service-role key in the app.

## Configure Supabase

1. Create a Supabase project and run [`supabase/schema.sql`](supabase/schema.sql) in its SQL editor.
2. Enable email authentication and set the site's URL and allowed redirect URLs for local development and the GitHub Pages URL.
3. Configure `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env.local` to develop locally.
4. For deployment, enable GitHub Pages with **GitHub Actions** as the source, then add repository Actions secrets with those same names. The published JavaScript contains the public anon key; database access is restricted by the schema's Row Level Security policies.

The Pages workflow publishes this repository at `/flash-card/`. If you use a custom domain or rename the repository, update `base` in `vite.config.js`.

## Import and review

- Import UTF-8 `.csv` or `.xlsx` files up to 20 MB and 10,000 rows. Excel workbooks allow selecting a sheet.
- Click **Nhập tệp**, then **Chọn tệp** to select a file. Selecting it opens the preview; click **Xác nhận nhập** to save. No sign-in is required in local-only mode.
- Map file columns, choose a default category/language, and review each row before saving. Required values can be corrected in the preview or the row can be excluded.
- Existing words are matched case-insensitively by word and language. For each match, choose update, skip, or add as a separate entry. The preview compares all fields; unmapped fields stay as-is, while mapped blank cells clear the existing value.
- CSV quoting is respected. Spreadsheet formulas are not evaluated. Data is displayed as text.
- List and category views open the same full detail view. A word can have more than one category.
- In the detail view, use the settings icon to edit only **Nghĩa**, **Ví dụ**, and **Category**, then choose **Lưu** or **Hủy**. Separate multiple categories with `;` or `|`; clearing Category removes all category assignments. Nghĩa is required.
- **Xóa từ vựng** requires confirmation and permanently removes the word from the list. Edits and deletions use local storage or your signed-in Supabase account.
- Auto review waits the configured 1–10 seconds on each face, stops after the last word, and pauses for manual actions or when the page becomes hidden.
- Browser speech reads only the original word or its optional “Văn bản đọc” text. French voices and quality depend on the device; voice selection is saved on that device.

## Validate

```sh
npm test
npm run build
```
