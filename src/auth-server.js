import http from 'http';
import url from 'url';
import { exchangeCode } from './oauth.js';
import { saveOAuthTokens, getDefaultSheetColumns } from './db/queries.js';
import { createSpreadsheet } from './sheets.js';
import logger from './logger.js';

const SUCCESS_HTML = (spreadsheetUrl) => `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Autorizado</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, sans-serif; display: flex; justify-content: center;
         align-items: center; min-height: 100vh; margin: 0; background: #f0fdf4; }
  .card { background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,.1);
          text-align: center; max-width: 480px; }
  .check { font-size: 4rem; } h1 { color: #166534; } p { color: #4b5563; }
  .url { background: #f3f4f6; padding: .5rem 1rem; border-radius: .5rem; font-size: .8rem;
         word-break: break-all; margin: 1rem 0; font-family: monospace; }
  .btn { display: inline-block; background: #166534; color: white; padding: .75rem 1.5rem;
         border-radius: .5rem; text-decoration: none; margin-top: 1rem; font-weight: 600; }
</style></head>
<body><div class="card">
  <div class="check">✅</div>
  <h1>Autorización completada</h1>
  <p>Tu hoja de cálculo fue creada exitosamente.</p>
  <a class="btn" href="${spreadsheetUrl}" target="_blank">Abrir hoja 📊</a>
  <p style="margin-top:1.5rem;font-size:.9rem;color:#6b7280;">
    Ya puedes cerrar esta ventana y volver a Telegram.<br>
    El bot te ha enviado un mensaje de confirmación.
  </p>
</div></body></html>`;

const ERROR_HTML = (msg) => `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Error</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, sans-serif; display: flex; justify-content: center;
         align-items: center; min-height: 100vh; margin: 0; background: #fef2f2; }
  .card { background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,.1);
          text-align: center; max-width: 480px; }
  .x { font-size: 4rem; } h1 { color: #991b1b; } p { color: #4b5563; }
</style></head>
<body><div class="card">
  <div class="x">❌</div>
  <h1>Error de autorización</h1>
  <p>${msg}</p>
</div></body></html>`;

export function startAuthServer(port, oauthPending, botToken) {
  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);

    if (parsed.pathname === '/oauth/callback' && req.method === 'GET') {
      const { code, state, error: oauthError } = parsed.query;

      if (oauthError) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML(`Google respondió con error: ${oauthError}. Intenta de nuevo con /setup.`));
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML('Faltan parámetros (code, state). Asegúrate de usar el enlace completo.'));
        return;
      }

      const session = oauthPending.get(state);
      if (!session) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML('Sesión inválida o expirada. Usa /setup en Telegram para generar un nuevo enlace.'));
        return;
      }

      const defaultCols = await getDefaultSheetColumns();

      try {
        logger.info('Intercambiando código por tokens...');
        const tokens = await exchangeCode(code, session.redirectUri);

        logger.info('Creando spreadsheet...');
        const { spreadsheetId, spreadsheetUrl } = await createSpreadsheet({
          accessToken: tokens.access_token,
          sheetColumns: defaultCols,
        });

        logger.info('Guardando tokens en DB...');
        await saveOAuthTokens(session.userId, {
          refreshToken: tokens.refresh_token,
          scopes: tokens.scope || '',
          spreadsheetId,
        });

        session._completed = true;
        session._completedAt = Date.now();
        session._spreadsheetUrl = spreadsheetUrl;
        logger.info('OAuth2 completado para usuario', { userId: session.userId, spreadsheetId });

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SUCCESS_HTML(spreadsheetUrl));

        logger.info('Enviando notificación a Telegram...');
        try {
          const sendRes = await fetch(
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: session.chatId,
                text: `✅ Configuración completada!\n\n📊 Nueva hoja creada:\n${spreadsheetUrl}\n\nYa puedes enviarme capturas de Pago Móvil para registrarlas automáticamente. 📸`,
                disable_web_page_preview: true,
              }),
            }
          );
          if (!sendRes.ok) {
            const errText = await sendRes.text();
            logger.warn('Telegram respondi\u00f3 con error al notificar', { status: sendRes.status, body: errText.slice(0, 300) });
          } else {
            logger.info('Notificaci\u00f3n enviada a Telegram');
          }
        } catch (notifErr) {
          logger.warn('No se pudo notificar a Telegram (el servidor OAuth no tiene acceso directo)', { error: notifErr.message });
        }
      } catch (err) {
        logger.error('Error en callback OAuth', { error: err.message });

        oauthPending.delete(state);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML(`Error: ${err.message}. Usa /setup de nuevo.`));
      }
      return;
    }

    if (parsed.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', pending: oauthPending.size }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(ERROR_HTML('Ruta no encontrada. Usa /setup en Telegram.'));
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      logger.info(`Servidor OAuth escuchando en puerto ${port}`);
      resolve(server);
    });
  });
}
