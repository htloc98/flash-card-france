PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE vocabularies (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  word TEXT NOT NULL CHECK (length(trim(word)) BETWEEN 1 AND 500),
  pronunciation TEXT NOT NULL DEFAULT '',
  part_of_speech TEXT NOT NULL DEFAULT '',
  meaning TEXT NOT NULL CHECK (length(trim(meaning)) BETWEEN 1 AND 10000),
  example TEXT NOT NULL DEFAULT '',
  read_text TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'fr-FR',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (owner_id, id)
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  UNIQUE (owner_id, name),
  UNIQUE (owner_id, id)
);

CREATE TABLE vocabulary_categories (
  owner_id TEXT NOT NULL,
  vocabulary_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  PRIMARY KEY (vocabulary_id, category_id),
  FOREIGN KEY (owner_id, vocabulary_id) REFERENCES vocabularies(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, category_id) REFERENCES categories(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE user_settings (
  owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  front_delay INTEGER NOT NULL DEFAULT 4 CHECK (front_delay BETWEEN 1 AND 10),
  back_delay INTEGER NOT NULL DEFAULT 4 CHECK (back_delay BETWEEN 1 AND 10),
  auto_speak INTEGER NOT NULL DEFAULT 0 CHECK (auto_speak IN (0, 1))
);

CREATE TABLE seed_imports (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seed_key TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (owner_id, seed_key)
);

CREATE INDEX vocabularies_owner_paging ON vocabularies(owner_id);
CREATE INDEX vocabulary_categories_owner ON vocabulary_categories(owner_id, vocabulary_id);
CREATE INDEX vocabulary_categories_category ON vocabulary_categories(owner_id, category_id);