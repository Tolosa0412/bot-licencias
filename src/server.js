import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import db from './database.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'licencias-bot-secret-2024';

app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const auth = (req, res, next) => {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'No autorizado' });
        try { req.user = jwt.verify(token, JWT_SECRET); next(); }
        catch { res.status(401).json({ error: 'Token invalido' }); }
};

// API PUBLICA
app.get('/api/licencia/:clave', async (req, res) => {
        try {
                    const { clave } = req.params;
                    const result = await db.execute({ sql: `SELECT l.*, c.nombre, c.tipo_bot, c.activo as cliente_activo FROM licencias l JOIN clientes c ON l.cliente_id = c.id WHERE l.clave = ?`, args: [clave] });
                    const licencia = result.rows[0];
                    if (!licencia) return res.json({ activa: false, motivo: 'Licencia no encontrada' });
                    await db.execute({ sql: 'UPDATE licencias SET ultimo_check = datetime("now") WHERE clave = ?', args: [clave] });
                    if (!licencia.activa || !licencia.cliente_activo) return res.json({ activa: false, motivo: 'Licencia suspendida' });
                    if (licencia.fecha_vencimiento && new Date(licencia.fecha_vencimiento) < new Date()) {
                                    await db.execute({ sql: 'UPDATE licencias SET activa = 0 WHERE clave = ?', args: [clave] });
                                    return res.json({ activa: false, motivo: 'Licencia vencida' });
                    }
                    res.json({ activa: true, cliente: licencia.nombre, tipo_bot: licencia.tipo_bot, vencimiento: licencia.fecha_vencimiento });
        } catch (e) { res.status(500).json({ error: e.message }); }
});

// LOGIN
app.post('/api/admin/login', async (req, res) => {
        try {
                    const { username, password } = req.body;
                    const result = await db.execute({ sql: 'SELECT * FROM admin_users WHERE username = ?', args: [username] });
                    const user = result.rows[0];
                    if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Credenciales incorrectas' });
                    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
                    res.json({ token, username: user.username });
        } catch (e) { res.status(500).json({ error: e.message }); }
});

// CLIENTES
app.get('/api/admin/clientes', auth, async (req, res) => {
        try {
                    const result = await db.execute(`SELECT c.*, l.clave, l.activa as licencia_activa, l.ultimo_check, l.fecha_vencimiento as lic_vencimiento, COUNT(p.id) as total_pagos, SUM(p.monto) as total_pagado FROM clientes c LEFT JOIN licencias l ON l.cliente_id = c.id LEFT JOIN pagos p ON p.cliente_id = c.id GROUP BY c.id ORDER BY c.fecha_registro DESC`);
                    res.json(result.rows);
        } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/clientes', auth, async (req, res) => {
        try {
                    const { nombre, telefono, whatsapp_admin, tipo_bot, plan, precio, notas } = req.body;
                    if (!nombre || !telefono || !whatsapp_admin) return res.status(400).json({ error: 'Datos requeridos' });
                    const vencimiento = new Date();
                    plan === 'mensual' ? vencimiento.setMonth(vencimiento.getMonth() + 1) : vencimiento.setDate(vencimiento.getDate() + 7);
                    const r = await db.execute({ sql: `INSERT INTO clientes (nombre, telefono, whatsapp_admin, tipo_bot, plan, precio, notas, fecha_vencimiento, fecha_ultimo_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`, args: [nombre, telefono, whatsapp_admin, tipo_bot || 'sin_marco', plan || 'semanal', precio || 1000, notas || '', vencimiento.toISOString()] });
                    const clave = `BOT-${uuidv4().toUpperCase().slice(0, 8)}-${Date.now().toString(36).toUpperCase()}`;
                    await db.execute({ sql: `INSERT INTO licencias (cliente_id, clave, activa, fecha_vencimiento) VALUES (?, ?, 1, ?)`, args: [r.lastInsertRowid, clave, vencimiento.toISOString()] });
                    res.json({ success: true, cliente_id: r.lastInsertRowid, clave_licencia: clave });
        } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/clientes/:id/toggle', auth, async (req, res) => {
        try {
                    const { id } = req.params;
                    const r = await db.execute({ sql: 'SELECT * FROM clientes WHERE id = ?', args: [id] });
                    const cliente = r.rows[0];
                    if (!cliente) return res.status(404).json({ error: 'No encontrado' });
                    const nuevoEstado = cliente.activo ? 0 : 1;
                    await db.execute({ sql: 'UPDATE clientes SET activo = ? WHERE id = ?', args: [nuevoEstado, id] });
                    await db.execute({ sql: 'UPDATE licencias SET activa = ? WHERE cliente_id = ?', args: [nuevoEstado, id] });
                    res.json({ success: true, activo: nuevoEstado === 1, mensaje: nuevoEstado ? 'Activado' : 'DESACTIVADO - bot se apagara en max 30 min' });
        } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/clientes/:id/renovar', auth, async (req, res) => {
        try {
                    const { id } = req.params;
                    const { monto, notas } = req.body;
                    const r = await db.execute({ sql: 'SELECT * FROM clientes WHERE id = ?', args: [id] });
                    const cliente = r.rows[0];
                    if (!cliente) return res.status(404).json({ error: 'No encontrado' });
                    const nuevaFecha = new Date();
                    cliente.plan === 'mensual' ? nuevaFecha.setMonth(nuevaFecha.getMonth() + 1) : nuevaFecha.setDate(nuevaFecha.getDate() + 7);
                    await db.execute({ sql: 'UPDATE clientes SET fecha_vencimiento = ?, fecha_ultimo_pago = datetime("now"), activo = 1 WHERE id = ?', args:
