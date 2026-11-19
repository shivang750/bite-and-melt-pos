import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });

export function openDb(file = path.join(DATA_DIR, 'bitemelt.db')) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, full_name TEXT DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('admin','staff')), pass_salt TEXT NOT NULL, pass_hash TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, sort_order INTEGER NOT NULL DEFAULT 0, visible INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL, price INTEGER NOT NULL CHECK (price >= 0), image TEXT DEFAULT '',
  available INTEGER NOT NULL DEFAULT 1, visible INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY, bill_no TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, local_date TEXT NOT NULL,
  order_type TEXT NOT NULL, customer_name TEXT DEFAULT '', customer_phone TEXT DEFAULT '', notes TEXT DEFAULT '',
  subtotal INTEGER NOT NULL, item_discount INTEGER NOT NULL, bill_disc_type TEXT NOT NULL DEFAULT 'none', bill_disc_value REAL NOT NULL DEFAULT 0,
  bill_discount INTEGER NOT NULL, discount_total INTEGER NOT NULL, tax_total INTEGER NOT NULL DEFAULT 0, round_off INTEGER NOT NULL DEFAULT 0,
  grand_total INTEGER NOT NULL, gst_rate REAL NOT NULL DEFAULT 0, gst_mode TEXT NOT NULL DEFAULT 'exclusive',
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','upi','other')),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('paid','pending')), paid_at TEXT, payment_ref TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  void_reason TEXT DEFAULT '', voided_at TEXT, voided_by TEXT DEFAULT '', void_authorized_by TEXT DEFAULT '',
  created_by TEXT DEFAULT '', offline INTEGER NOT NULL DEFAULT 0, synced_at TEXT);
CREATE INDEX IF NOT EXISTS idx_bills_date ON bills(local_date);
CREATE INDEX IF NOT EXISTS idx_bills_phone ON bills(customer_phone);
CREATE TABLE IF NOT EXISTS bill_items (
  id INTEGER PRIMARY KEY, bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  item_id INTEGER, name TEXT NOT NULL, category TEXT DEFAULT '', qty INTEGER NOT NULL, price INTEGER NOT NULL,
  disc_type TEXT NOT NULL DEFAULT 'none', disc_value REAL NOT NULL DEFAULT 0, disc_amount INTEGER NOT NULL DEFAULT 0, line_total INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_items(bill_id);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  method TEXT NOT NULL, amount INTEGER NOT NULL, reference TEXT DEFAULT '', recorded_by TEXT DEFAULT '', recorded_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual');
-- online payment links (added later; CREATE IF NOT EXISTS keeps existing databases untouched)
CREATE TABLE IF NOT EXISTS payment_links (
  id INTEGER PRIMARY KEY, bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE, provider TEXT NOT NULL,
  link_id TEXT NOT NULL UNIQUE, short_url TEXT NOT NULL, reference TEXT NOT NULL, amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'created', created_at TEXT NOT NULL, expires_at TEXT, updated_at TEXT, paid_at TEXT, gateway_payment_id TEXT DEFAULT '', note TEXT DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_plinks_bill ON payment_links(bill_id);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_key TEXT PRIMARY KEY, provider TEXT NOT NULL, received_at TEXT NOT NULL, outcome TEXT DEFAULT '');
`);
  // Public bill links (WhatsApp): random token per bill. Added later, so migrate older databases.
  if (!db.prepare('PRAGMA table_info(bills)').all().some((c) => c.name === 'public_token')) db.exec('ALTER TABLE bills ADD COLUMN public_token TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_public_token ON bills(public_token) WHERE public_token IS NOT NULL');
  fs.mkdirSync(path.join(DATA_DIR, 'receipts'), { recursive: true });
  seed(db);
  return db;
}

export const DEFAULT_SETTINGS = {
  cafe_name: 'BITE AND MELT',
  address: 'Shop No. 6, Sugam Apartment, Opposite Agriculture Gate No. 1, Eru Road, Navsari, Gujarat',
  phone: '9978463006', logo: '', print_logo: '1', footer: 'Big Taste. Better Price.',
  currency: '₹', upi_id: 'gpay-12207298509@okbizaxis', payee_name: 'BITE AND MELT', upi_ref: '',
  gst_enabled: '0', gst_rate: '5', gst_mode: 'exclusive', gst_number: '', round_off: '0',
  bill_format: 'BM-{YYMMDD}-{SEQ4}', printer: '{}',
};
const BOOL_KEYS = new Set(['print_logo', 'gst_enabled', 'round_off']);

export function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  const s = { ...out };
  for (const k of BOOL_KEYS) s[k] = out[k] === '1';
  s.gst_rate = Number(out.gst_rate) || 0;
  try { s.printer = JSON.parse(out.printer || '{}'); } catch { s.printer = {}; }
  return s;
}
export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

function seed(db) {
  const hasCats = db.prepare('SELECT COUNT(*) c FROM categories').get().c;
  const seeded = db.prepare("SELECT value FROM settings WHERE key='seeded'").get();
  if (hasCats || seeded) return;
  const SAMPLE = {
    cats: ['Burgers', 'Sandwiches', 'Pizza', 'Fries', 'Maggi', 'Beverages', 'Other Items'],
    items: {
      Burgers: [['Veg Burger', 60], ['Cheese Burger', 80], ['Paneer Burger', 110], ['Double Patty Burger', 130]],
      Sandwiches: [['Veg Grilled Sandwich', 70], ['Cheese Grilled Sandwich', 90], ['Paneer Tikka Sandwich', 120]],
      Pizza: [['Margherita Pizza', 120], ['Veg Loaded Pizza', 180], ['Paneer Tikka Pizza', 220]],
      Fries: [['Salted Fries', 60], ['Peri Peri Fries', 80], ['Cheese Fries', 100]],
      Maggi: [['Plain Maggi', 50], ['Veg Masala Maggi', 70], ['Cheese Maggi', 90]],
      Beverages: [['Cold Coffee', 80], ['Masala Chai', 20], ['Fresh Lime Soda', 40], ['Chocolate Shake', 100]],
      'Other Items': [['Garlic Bread', 90], ['Brownie', 70], ['Water Bottle', 20]],
    },
  };
  // The cafe's real menu (prices in rupees). Re-created automatically whenever the database is empty (e.g. a free Render restart).
  const REAL = {
    cats: ['Burger', 'Sandwich', 'Pizza', 'Fries', 'Maggi', 'Cold Coffee', 'Cold Drinks', 'Garlic Bread'],
    items: {
      Burger: [['Bite and Melt Sp. Burger', 30], ['Bite and Melt Sp. Burger (Cheese)', 45], ['Veg. Burger', 30], ['Veg. Burger (Cheese)', 45]],
      Sandwich: [['Bread Butter', 30], ['Bread Butter Jam', 35], ['Veg. Sandwich', 40], ['Cheese Chutney Sandwich', 50], ['Corn Cheese Sandwich', 60],
        ['Veg. Cheese Grill', 60], ['Aloo Cheese Chutney', 60], ['Paneer Makhani', 60], ['Cheese Chilli Sandwich', 60], ['Bite & Melt Sp. Sandwich', 70], ['Paneer Makhani Cheese', 80]],
      Pizza: [['Capsi-Crunch Pizza', 129], ['Spicy Peri Veg. Pizza', 139], ['Veg Carnival Pizza', 149], ['Signature Cheese Pizza', 149], ['Tandoori Paneer Pizza', 159]],
      Fries: [['Salted Fries', 50], ['Peri Peri Fries', 60], ['Cheese Fries', 70]],
      Maggi: [['Masala Maggi', 40], ['Veg. Maggi', 50], ['Veg. Cheese Maggi', 70]],
      'Cold Coffee': [['Cold Coffee', 30], ['Hazlnut Cold Coffee', 40], ['Caramel Cold Coffee', 40], ['Chocolate Cold Coffee', 40]],
      'Cold Drinks': [['Fanta 250ml', 20], ['Sprite 250ml', 20], ['Coke 250ml', 20], ['Thums Up 250ml', 20], ['Maaza 250ml', 20], ['Sosyo 250ml', 20], ['Sosyo 150ml', 10], ['Diet Coke 330ml', 50], ['Clear Water 500ml', 10]],
      'Garlic Bread': [['Garlic Bread', 50]],
    },
  };
  // BM_SEED=sample is used only by the automated tests (they were written against these sample prices).
  const { cats, items } = process.env.BM_SEED === 'sample' ? SAMPLE : REAL;
  db.exec('BEGIN');
  cats.forEach((c, i) => {
    const id = db.prepare('INSERT INTO categories(name,sort_order) VALUES(?,?)').run(c, i + 1).lastInsertRowid;
    items[c].forEach(([n, p], j) => db.prepare('INSERT INTO items(category_id,name,price,sort_order) VALUES(?,?,?,?)').run(id, n, p * 100, j + 1));
  });
  setSetting(db, 'seeded', '1');
  db.exec('COMMIT');
}
