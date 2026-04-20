import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import bcrypt from 'bcryptjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '..', 'licencias.db'));

// Crear tablas
db.exec(`
    CREATE TABLE IF NOT EXISTS clientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        telefono TEXT NOT NULL,
        whatsapp_admin TEXT NOT NULL,
        tipo_bot TEXT DEFAULT 'sin_marco',
        plan TEXT DEFAULT 'semanal',
        precio REAL DEFAULT 1000,
        activo INTEGER DEFAULT 1,
        fecha_registro TEXT DEFAULT (datetime('now')),
        fecha_vencimiento TEXT,
        fecha_ultimo_pago TEXT,
        notas TEXT
    );

    CREATE TABLE IF NOT EXISTS licencias (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente_id INTEGER NOT NULL,
        clave TEXT UNIQUE NOT NULL,
        activa INTEGER DEFAULT 1,
        fecha_creacion TEXT DEFAULT (datetime('now')),
        fecha_vencimiento TEXT,
        ultimo_check TEXT,
        FOREIGN KEY (cliente_id) REFERENCES clientes(id)
    );

    CREATE TABLE IF NOT EXISTS pagos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente_id INTEGER NOT NULL,
        monto REAL NOT NULL,
        fecha_pago TEXT DEFAULT (datetime('now')),
        periodo_inicio TEXT,
        periodo_fin TEXT,
        notas TEXT,
        FOREIGN KEY (cliente_id) REFERENCES clientes(id)
    );

    CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
    );
`);

// Crear admin por defecto si no existe
const adminExiste = db.prepare('SELECT id FROM admin_users WHERE username = ?').get('admin');
if (!adminExiste) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run('admin', hash);
    console.log('✅ Admin creado: admin / admin123');
}

export default db;
