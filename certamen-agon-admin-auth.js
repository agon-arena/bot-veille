// Login admin Agôn partagé entre les modules Certamen (publication + idées IA + voix +
// notification). Ne sert que pour les étapes qui en ont réellement besoin (set-votes,
// push broadcast) : la publication elle-même (POST /api/debates) n'en a pas besoin.

const AGON_URL = (process.env.AGON_URL || "http://localhost:3001").trim();

async function loginAgonAdminForCertamen(logLabel = "certamen") {
  const adminPassword = process.env.AGON_ADMIN_PASSWORD;
  if (!adminPassword) {
    console.log(`[${logLabel}] AGON_ADMIN_PASSWORD absent — étape ignorée`);
    return null;
  }
  try {
    const loginRes = await fetch(`${AGON_URL}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: adminPassword })
    });
    if (!loginRes.ok) {
      console.error(`[${logLabel}] Échec login admin Agôn`);
      return null;
    }
    const { token } = await loginRes.json();
    return { "Content-Type": "application/json", "x-admin-token": token };
  } catch (err) {
    console.error(`[${logLabel}] Erreur login Agôn :`, err.message);
    return null;
  }
}

module.exports = { AGON_URL, loginAgonAdminForCertamen };
