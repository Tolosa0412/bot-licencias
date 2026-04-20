// ============================================================
// verificadorLicencia.js
// Verifica que la licencia del bot esté activa cada 30 min
// Si se desactiva → manda mensaje al admin y apaga el bot
// ============================================================

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { getDirname } from './dirname-helper.js';

const __dirname = getDirname(import.meta.url);

const SERVIDOR_LICENCIAS = process.env.SERVIDOR_LICENCIAS || 'http://localhost:4000';
const CLAVE_LICENCIA = process.env.CLAVE_LICENCIA || '';
const INTERVALO_VERIFICACION = 30 * 60 * 1000; // 30 minutos

let verificacionInterval = null;
let ultimaVerificacion = null;
let licenciaActiva = true;

function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] 🔑 [LICENCIA] ${msg}`);
}

async function verificarLicencia() {
    if (!CLAVE_LICENCIA) {
        log('⚠️ No hay clave de licencia configurada en .env');
        return true; // En desarrollo, permitir sin clave
    }

    return new Promise((resolve) => {
        const url = `${SERVIDOR_LICENCIAS}/api/licencia/${CLAVE_LICENCIA}`;
        const protocol = url.startsWith('https') ? https : http;

        const req = protocol.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const resultado = JSON.parse(data);
                    ultimaVerificacion = new Date();
                    
                    if (resultado.activa) {
                        if (!licenciaActiva) {
                            log('✅ Licencia reactivada');
                        }
                        licenciaActiva = true;
                        log(`✅ Licencia válida - Cliente: ${resultado.cliente}`);
                        resolve(true);
                    } else {
                        licenciaActiva = false;
                        log(`❌ Licencia INACTIVA: ${resultado.motivo}`);
                        resolve(false);
                    }
                } catch (e) {
                    log('⚠️ Error parseando respuesta del servidor');
                    resolve(true); // En caso de error de red, no apagar el bot
                }
            });
        });

        req.on('error', () => {
            log('⚠️ No se pudo conectar al servidor de licencias (continuando...)');
            resolve(true); // Si no hay internet, no apagar el bot
        });

        req.setTimeout(10000, () => {
            req.destroy();
            log('⚠️ Timeout verificando licencia (continuando...)');
            resolve(true);
        });
    });
}

async function iniciarVerificacion(sock) {
    log('🚀 Iniciando verificador de licencias...');

    // Verificar al inicio
    const activa = await verificarLicencia();
    
    if (!activa) {
        await manejarLicenciaInactiva(sock);
        return false;
    }

    // Verificar cada 30 minutos
    verificacionInterval = setInterval(async () => {
        const activa = await verificarLicencia();
        if (!activa) {
            await manejarLicenciaInactiva(sock);
        }
    }, INTERVALO_VERIFICACION);

    log(`⏰ Verificación automática cada 30 minutos`);
    return true;
}

async function manejarLicenciaInactiva(sock) {
    log('🛑 Licencia inactiva - apagando bot...');

    // Avisar al admin por WhatsApp si es posible
    if (sock && global.client) {
        try {
            const adminNum = process.env.ADMIN_WHATSAPP || '';
            if (adminNum) {
                const jid = adminNum.includes('@') ? adminNum : `${adminNum}@s.whatsapp.net`;
                await global.client.sendMessage(jid, {
                    text: '⚠️ *SERVICIO SUSPENDIDO*\n\nTu licencia del bot ha sido desactivada.\n\nPor favor contacta al proveedor para renovar tu servicio.\n\n_Este mensaje es automático._'
                }, { skipHumanSimulation: true });
            }
        } catch (e) {
            log('No se pudo enviar mensaje de aviso');
        }
    }

    // Esperar 5 segundos y apagar
    setTimeout(() => {
        log('🛑 Cerrando bot por licencia inactiva...');
        process.exit(0);
    }, 5000);
}

function detenerVerificacion() {
    if (verificacionInterval) {
        clearInterval(verificacionInterval);
        verificacionInterval = null;
        log('Verificación detenida');
    }
}

function obtenerEstado() {
    return {
        activa: licenciaActiva,
        ultimaVerificacion,
        clavConfigurada: !!CLAVE_LICENCIA,
        servidor: SERVIDOR_LICENCIAS
    };
}

export {
    iniciarVerificacion,
    verificarLicencia,
    detenerVerificacion,
    obtenerEstado
};

export default {
    iniciarVerificacion,
    verificarLicencia,
    detenerVerificacion,
    obtenerEstado
};
