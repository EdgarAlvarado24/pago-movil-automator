import { google } from 'googleapis';
import logger from './logger.js';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

export function getOAuth2Client(redirectUri) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  );
}

export function generateAuthUrl(state, redirectUri) {
  const oauth2Client = getOAuth2Client(redirectUri);

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    state,
    prompt: 'consent',
  });
}

export async function exchangeCode(code, redirectUri) {
  const oauth2Client = getOAuth2Client(redirectUri);
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      'No se obtuvo refresh_token. Asegúrate de que el usuario no haya ' +
      'autorizado previamente sin revocar. Usa prompt=consent.'
    );
  }

  return tokens;
}

export async function getAccessToken(refreshToken) {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const { token } = await oauth2Client.getAccessToken();
  return token;
}

export async function refreshAccessTokenIfNeeded(refreshToken) {
  try {
    const accessToken = await getAccessToken(refreshToken);
    logger.debug('Access token renovado exitosamente');
    return accessToken;
  } catch (err) {
    if (err.message?.includes('invalid_grant') || err.message?.includes('token has been revoked')) {
      throw new Error(
        'El acceso a Google ha sido revocado o expiró. ' +
        'Usa /setup para autorizar de nuevo.'
      );
    }
    throw new Error(`Error renovando token: ${err.message}`);
  }
}
