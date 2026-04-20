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

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ─── MIDDLEWARE AUTH ────────────────────────────────────────────
const auth = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No autorizado' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Token inválido' });
    }
};

// ════════════════════════════════════════════════════════════════
// API PÚBLICA - Para que los bots verifiquen su licencia
// ════════════════════════════════════════════════════════════════

// El bot llama esto cada 30 min para saber si puede seguir
app.get('/api/licencia/:clave', (req, res) => {
    const { clave } = req.params;
    
    const licencia = db.prepare(`
        SELECT l.*, c.nombre, c.tipo_bot, c.activo as cliente_activo
        FROM licencias l
        JOIN clientes c ON l.cliente_id = c.id
        WHERE l.clave = ?
    `).get(clave);

    if (!licencia) {
        return res.json({ activa: false, motivo: 'Licencia no encontrada' });
    }

    // Actualizar último check
    db.prepare('UPDATE licencias SET ultimo_check = datetime("now") WHERE clave = ?').run(clave);

    // Verificar si está activa
    if (!licencia.activa || !licencia.cliente_activo) {
        return res.json({ activa: false, motivo: 'Licencia suspendida por falta de pago' });
    }

    // Verificar vencimiento
    if (licencia.fecha_vencimiento) {
        const vencimiento = new Date(licencia.fecha_vencimiento);
        if (vencimiento < new Date()) {
            db.prepare('UPDATE licencias SET activa = 0 WHERE clave = ?').run(clave);
            return res.json({ activa: false, motivo: 'Licencia vencida' });
        }
    }

    res.json({
        activa: true,
        cliente: licencia.nombre,
        tipo_bot: licencia.tipo_bot,
        vencimiento: licencia.fecha_vencimiento,
        mensaje: 'Licencia válida'
    });
});

// ════════════════════════════════════════════════════════════════
// API PRIVADA - Solo para ti (requiere login)
// ════════════════════════════════════════════════════════════════

// Login
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
    
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, username: user.username });
});

// ─── CLIENTES ───────────────────────────────────────────────────

// Listar todos los clientes
app.get('/api/admin/clientes', auth, (req, res) => {
    const clientes = db.prepare(`
        SELECT c.*, 
               l.clave, l.activa as licencia_activa, l.ultimo_check,
               l.fecha_vencimiento as lic_vencimiento,
               COUNT(p.id) as total_pagos,
               SUM(p.monto) as total_pagado
        FROM clientes c
        LEFT JOIN licencias l ON l.cliente_id = c.id
        LEFT JOIN pagos p ON p.cliente_id = c.id
        GROUP BY c.id
        ORDER BY c.fecha_registro DESC
    `).all();
    res.json(clientes);
});

// Crear nuevo cliente + licencia
app.post('/api/admin/clientes', auth, (req, res) => {
    const { nombre, telefono, whatsapp_admin, tipo_bot, plan, precio, notas } = req.body;
    
    if (!nombre || !telefono || !whatsapp_admin) {
        return res.status(400).json({ error: 'Nombre, teléfono y WhatsApp admin son requeridos' });
    }

    // Calcular fecha de vencimiento
    const ahora = new Date();
    const vencimiento = new Date(ahora);
    if (plan === 'mensual') {
        vencimiento.setMonth(vencimiento.getMonth() + 1);
    } else {
        vencimiento.setDate(vencimiento.getDate() + 7);
    }

    // Crear cliente
    const result = db.prepare(`
        INSERT INTO clientes (nombre, telefono, whatsapp_admin, tipo_bot, plan, precio, notas, fecha_vencimiento, fecha_ultimo_pago)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(nombre, telefono, whatsapp_admin, tipo_bot || 'sin_marco', plan || 'semanal', precio || 1000, notas || '', vencimiento.toISOString());

    // Generar clave de licencia única
    const clave = `BOT-${uuidv4().toUpperCase().slice(0, 8)}-${Date.now().toString(36).toUpperCase()}`;

    // Crear licencia
    db.prepare(`
        INSERT INTO licencias (cliente_id, clave, activa, fecha_vencimiento)
        VALUES (?, ?, 1, ?)
    `).run(result.lastInsertRowid, clave, vencimiento.toISOString());

    res.json({ success: true, cliente_id: result.lastInsertRowid, clave_licencia: clave });
});

// Activar/Desactivar licencia
app.post('/api/admin/clientes/:id/toggle', auth, (req, res) => {
    const { id } = req.params;
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(id);
    
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    const nuevoEstado = cliente.activo ? 0 : 1;
    db.prepare('UPDATE clientes SET activo = ? WHERE id = ?').run(nuevoEstado, id);
    db.prepare('UPDATE licencias SET activa = ? WHERE cliente_id = ?').run(nuevoEstado, id);

    res.json({ 
        success: true, 
        activo: nuevoEstado === 1,
        mensaje: nuevoEstado ? 'Cliente activado' : 'Cliente DESACTIVADO - bot se apagará en max 30 min'
    });
});

// Renovar licencia (registrar pago)
app.post('/api/admin/clientes/:id/renovar', auth, (req, res) => {
    const { id } = req.params;
    const { monto, notas } = req.body;
    
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Calcular nueva fecha de vencimiento desde hoy
    const ahora = new Date();
    const nuevaFecha = new Date(ahora);
    if (cliente.plan === 'mensual') {
        nuevaFecha.setMonth(nuevaFecha.getMonth() + 1);
    } else {
        nuevaFecha.setDate(nuevaFecha.getDate() + 7);
    }

    // Actualizar cliente y licencia
    db.prepare('UPDATE clientes SET fecha_vencimiento = ?, fecha_ultimo_pago = datetime("now"), activo = 1 WHERE id = ?')
      .run(nuevaFecha.toISOString(), id);
    db.prepare('UPDATE licencias SET activa = 1, fecha_vencimiento = ? WHERE cliente_id = ?')
      .run(nuevaFecha.toISOString(), id);

    // Registrar pago
    db.prepare(`INSERT INTO pagos (cliente_id, monto, periodo_inicio, periodo_fin, notas) VALUES (?, ?, datetime('now'), ?, ?)`)
      .run(id, monto || cliente.precio, nuevaFecha.toISOString(), notas || '');

    res.json({ success: true, nueva_fecha: nuevaFecha.toISOString() });
});

// Historial de pagos de un cliente
app.get('/api/admin/clientes/:id/pagos', auth, (req, res) => {
    const pagos = db.prepare('SELECT * FROM pagos WHERE cliente_id = ? ORDER BY fecha_pago DESC').all(req.params.id);
    res.json(pagos);
});

// Eliminar cliente
app.delete('/api/admin/clientes/:id', auth, (req, res) => {
    const { id } = req.params;
    db.prepare('DELETE FROM licencias WHERE cliente_id = ?').run(id);
    db.prepare('DELETE FROM pagos WHERE cliente_id = ?').run(id);
    db.prepare('DELETE FROM clientes WHERE id = ?').run(id);
    res.json({ success: true });
});

// Estadísticas generales
app.get('/api/admin/stats', auth, (req, res) => {
    const total = db.prepare('SELECT COUNT(*) as n FROM clientes').get().n;
    const activos = db.prepare('SELECT COUNT(*) as n FROM clientes WHERE activo = 1').get().n;
    const vencenHoy = db.prepare(`SELECT COUNT(*) as n FROM clientes WHERE date(fecha_vencimiento) <= date('now') AND activo = 1`).get().n;
    const ingresoMes = db.prepare(`SELECT COALESCE(SUM(monto), 0) as total FROM pagos WHERE strftime('%Y-%m', fecha_pago) = strftime('%Y-%m', 'now')`).get().total;
    
    res.json({ total, activos, inactivos: total - activos, vencenHoy, ingresoMes });
});

// ─── PANEL WEB ──────────────────────────────────────────────────
app.get('*', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`\n🚀 Servidor de Licencias corriendo en puerto ${PORT}`);
    console.log(`📊 Panel admin: http://localhost:${PORT}`);
    console.log(`🔑 API licencias: http://localhost:${PORT}/api/licencia/[CLAVE]\n`);
});
