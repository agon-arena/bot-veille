"use strict";
function requireOpenAgendaKey(value) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error('OPENAGENDA_PUBLIC_KEY absente ou vide : configurer la clé publique OpenAgenda du service');
    error.code = 'OPENAGENDA_KEY_MISSING';
    throw error;
  }
  return value.trim();
}
function openAgendaHttpError(status, agendaUid, stage) {
  const error = new Error(`OpenAgenda ${agendaUid} (${stage}) : HTTP ${status}`);
  error.code = status === 403 ? 'OPENAGENDA_FORBIDDEN' : status === 401 ? 'OPENAGENDA_UNAUTHORIZED' : 'OPENAGENDA_HTTP_ERROR';
  error.httpStatus = status;
  return error; // Never persist a response body that may echo credentials.
}
module.exports = { requireOpenAgendaKey, openAgendaHttpError };
