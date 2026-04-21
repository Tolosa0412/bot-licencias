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
const JWT_SECRET = process.env.JWT_SECRET || 'licencias-secret-2024';
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
app.get('/api/licencia/:clave', async (req, res) => {
    try {
        const { clave } = req.params;
        const r = await db.execute({ sql: 'SELECT l.*, c.nombre, c.tipo_bot, c.activo as cliente_activo FROM licencias l JOIN clientes c ON l.cliente_id = c.id WHERE l.clave = ?', args: [clave] });
        const lic = r.rows[0];
        if (!lic) return res.json({ activa: false, motivo: 'No encontrada' });
        await db.execute({ sql: 'UPDATE licencias SET ultimo_check = datetime("now") WHERE clave = ?', args: [clave] });
        if (!lic.activa || !lic.cliente_activo) return res.json({ activa: false, motivo: 'Suspendida' });
        if (lic.fecha_vencimiento && new Date(lic.fecha_vencimiento) < new Date()) return res.json({ activa: false, motivo: 'Vencida' });
        res.json({ activa: true, cliente: lic.nombre, tipo_bot: lic.tipo_bot });
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const r = await db.execute({ sql: 'SELECT * FROM admin_users WHERE username = ?', args: [username] });
        const user = r.rows[0];
        if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Credenciales incorrectas' });
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, username: user.username });
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/clientes', auth, async (req, res) => {
    try {
        const r = await db.execute('SELECT c.*, l.clave, l.activa as licencia_activa, l.ultimo_check FROM clientes c LEFT JOIN licencias l ON l.cliente_id = c.id ORDER BY c.fecha_registro DESC');
        res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/clientes', auth, async (req, res) => {
    try {
        const { nombre, telefono, whatsapp_admin, tipo_bot, plan, precio, notas } = req.body;
        if (!nombre || !telefono || !whatsapp_admin) return res.status(400).json({ error: 'Datos requeridos' });
        const venc = new Date();
        plan === 'mensual' ? venc.setMonth(venc.getMonth() + 1) : venc.setDate(venc.getDate() + 7);
        const ins = await db.execute({ sql: "INSERT INTO clientes (nombre, telefono, whatsapp_admin, tipo_bot, plan, precio, notas, fecha_vencimiento, fecha_ultimo_pago) VALUES (?,?,?,?,?,?,?,?,datetime('now'))", args: [nombre, telefono, whatsapp_admin, tipo_bot||'sin_marco', plan||'semanal', precio||1000, notas||'', venc.toISOString()] });
        const clave = 'BOT-' + uuidv4().toUpperCase().slice(0,8) + '-' + Date.now().toString(36).toUpperCase();
        await db.execute({ sql: 'INSERT INTO licencias (cliente_id, clave, activa, fecha_vencimiento) VALUES (?,?,1,?)', args: [ins.lastInsertRowid, clave, venc.toISOString()] });
        res.json({ success: true, clave_licencia: clave });
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/clientes/:id/toggle', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const c = (await db.execute({ sql: 'SELECT * FROM clientes WHERE id=?', args: [id] })).rows[0];
        if (!c) return res.status(404).json({ error: 'No encontrado' });
        const est = c.activo ? 0 : 1;
        await db.execute({ sql: 'UPDATE clientes SET activo=? WHERE id=?', args: [est, id] });
        await db.execute({ sql: 'UPDATE licencias SET activa=? WHERE cliente_id=?', args: [est, id] });
        res.json({ success: true, activo: est === 1 });
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/clientes/:id/renovar', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { monto, notas } = req.body;
        const c = (await db.execute({ sql: 'SELECT * FROM clientes WHERE id=?', args: [id] })).rows[0];
        if (!c) return res.status(404).json({ error: 'No encontrado' });
        const nf = new Date();
        c.plan === 'mensual' ? nf.setMonth(nf.getMonth()+1) : nf.setDate(nf.getDate()+7);
        await db.execute({ sql: 'UPDATE clientes SET fecha_vencimiento=?,activo=1 WHERE id=?', args: [nf.toISOString(), id] });
        await db.execute({ sql: 'UPDATE licencias SET activa=1,fecha_vencimiento=? WHERE cliente_id=?', args: [nf.toISOString(), id] });
        await db.execute({ sql: "INSERT INTO pagos (cliente_id,monto,periodo_fin,notas) VALUES (?,?,?,?)", args: [id, monto||c.precio, nf.toISOString(), notas||''] });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/stats', auth, async (req, res) => {
    try {
        const total = (await db.execute('SELECT COUNT(*) as n FROM clientes')).rows[0].n;
        const activos = (await db.execute('SELECT COUNT(*) as n FROM clientes WHERE activo=1')).rows[0].n;
        const ingreso = (await db.execute("SELECT COALESCE(SUM(monto),0) as t FROM pagos WHERE strftime('%Y-%m',fecha_pago)=strftime('%Y-%m','now')")).rows[0].t;
        res.json({ total, activos, inactivos: total-activos, ingresoMes: ingreso });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ENDPOINT ESPECIAL: crear cliente con clave especifica
app.post('/api/admin/clientes/clave-especifica', auth, async (req, res) => {
    try {
        const { nombre, telefono, whatsapp_admin, tipo_bot, plan, precio, clave_especifica } = req.body;
        if (!nombre || !telefono || !whatsapp_admin || !clave_especifica) return res.status(400).json({ error: 'Datos requeridos' });
        const venc = new Date();
        plan === 'mensual' ? venc.setMonth(venc.getMonth() + 1) : venc.setDate(venc.getDate() + 7);
        const ins = await db.execute({ sql: "INSERT INTO clientes (nombre, telefono, whatsapp_admin, tipo_bot, plan, precio, notas, fecha_vencimiento, fecha_ultimo_pago) VALUES (?,?,?,?,?,?,?,?,datetime('now'))", args: [nombre, telefono, whatsapp_admin, tipo_bot||'con_marco', plan||'semanal', precio||1000, '', venc.toISOString()] });
        await db.execute({ sql: 'INSERT INTO licencias (cliente_id, clave, activa, fecha_vencimiento) VALUES (?,?,1,?)', args: [ins.lastInsertRowid, clave_especifica, venc.toISOString()] });
        res.json({ success: true, clave_licencia: clave_especifica });
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('*', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log('Servidor en puerto ' + PORT));