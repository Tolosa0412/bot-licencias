import { createClient } from '@libsql/client';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import bcrypt from 'bcryptjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = createClient({ url: `file:${join(__dirname, '..', 'licencias.db')}` });

async function initDB() {
      await db.execute(`CREATE TABLE IF NOT EXISTS clientes (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, telefono TEXT NOT NULL, whatsapp_admin TEXT NOT NULL, tipo_bot TEXT DEFAULT 'sin_marco', plan TEXT DEFAULT 'semanal', precio REAL DEFAULT 1000, activo INTEGER DEFAULT 1, fecha_registro TEXT DEFAULT (datetime('now')), fecha_vencimiento TEXT, fecha_ultimo_pago TEXT, notas TEXT)`);
      await db.execute(`CREATE TABLE IF NOT EXISTS licencias (id INTEGER PRIMARY KEY AUTOINCREMENT, cliente_id INTEGER NOT NULL, clave TEXT UNIQUE NOT NULL, activa INTEGER DEFAULT 1, fecha_creacion TEXT DEFAULT (datetime('now')), fecha_vencimiento TEXT, ultimo_check TEXT)`);
      await db.execute(`CREATE TABLE IF NOT EXISTS pagos (id INTEGER PRIMARY KEY AUTOINCREMENT, cliente_id INTEGER NOT NULL, monto REAL NOT NULL, fecha_pago TEXT DEFAULT (datetime('now')), periodo_inicio TEXT, periodo_fin TEXT, notas TEXT)`);
      await db.execute(`CREATE TABLE IF NOT EXISTS admin_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
      const r = await db.execute({ sql: 'SELECT id FROM admin_users WHERE username = ?', args: ['admin'] });
      if (r.rows.length === 0) {
              const hash = bcrypt.hashSync('admin123', 10);
              await db.execute({ sql: 'INSERT INTO admin_users (username, password_hash) VALUES (?, ?)', args: ['admin', hash] });
      }
      console.log('DB lista');
}

await initDB();
export default db;
