// =====================================================================
// KONFIGURASI — WAJIB DIISI SEBELUM DEPLOY, DAN DIISI ULANG SETIAP KALI
// FILE INI DISALIN UNTUK PROYEK/INSTANSI LAIN.
// Lihat PANDUAN_DEPLOYMENT.md untuk cara mendapatkan tiap nilai di bawah.
// =====================================================================
window.APP_CONFIG = {
  // Project Settings > Data API > Project URL (Supabase Dashboard)
  SUPABASE_URL: "https://efmvyvctxylnwofszukn.supabase.co",

  // Project Settings > API Keys > Publishable key
  // (Ini kunci PUBLIK yang aman ditaruh di frontend — akses data tetap
  // dibatasi oleh Row Level Security di database, BUKAN oleh kerahasiaan
  // kunci ini. Jangan pernah taruh "Secret key" / service_role di sini.)
  SUPABASE_ANON_KEY: "sb_publishable_fWhLsKMC4dT8jDcEa_xCXA_EYECOq7w",

  // URL endpoint di Cloudflare Worker gateway yang menerima permintaan
  // analisa koding dan meneruskannya ke Anthropic API dengan API key
  // tersimpan di server (bukan di browser). Sesuaikan path-nya dengan
  // route yang benar-benar ada di worker Anda.
  GATEWAY_URL: "https://snowy-sun-899a.akhmad-tauhid.workers.dev",
  // Kalau gateway Anda mensyaratkan header otentikasi (mis. lisensi
  // internal RS, bukan lisensi pelanggan komersial), isi di sini dan
  // sesuaikan nama header-nya di app.js bagian runAnalysis().
  GATEWAY_KEY: "rsam-v2-9x7k2m4p8q",
};
