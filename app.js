// =====================================================================
// Sistem Terintegrasi INA-CBG v2 — Logika Aplikasi
// RSU Allam Medica — Supabase + Cloudflare Worker gateway
// =====================================================================
// Perbedaan besar dari v1 (lihat analisa kelemahan yang menyertai versi
// ini):
//  - Semua penyimpanan lewat Supabase (bukan window.storage, yang hanya
//    tersedia di dalam preview Claude.ai).
//  - Panggilan AI lewat GATEWAY_URL (Cloudflare Worker RS), bukan
//    langsung ke api.anthropic.com dari browser.
//  - Kode ICD-10/ICD-9-CM & tarif resmi dicari lewat query ke Supabase,
//    bukan array JS raksasa yang ditanam di file ini.
//  - Ada login (Supabase Auth) dan RLS per peran (admin/verifikator/koder).
// =====================================================================

const supabase = window.supabase.createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_ANON_KEY
);

let currentUser = null;
let currentProfile = null; // {id, full_name, role}

// ---------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------
async function initAuth(){
  const { data: { session } } = await supabase.auth.getSession();
  if(session){
    await onLoggedIn(session);
  } else {
    showLogin();
  }
  supabase.auth.onAuthStateChange((event, session) => {
    if(event === 'SIGNED_OUT'){ showLogin(); }
  });
}

function showLogin(){
  document.getElementById('loginScreen').style.display = 'block';
  document.getElementById('appScreen').style.display = 'none';
}

async function onLoggedIn(session){
  currentUser = session.user;
  const { data: profile, error } = await supabase.from('profiles').select('*').eq('id', currentUser.id).single();
  if(error || !profile){
    document.getElementById('loginErrBox').innerHTML =
      `<div class="err">Login berhasil, tapi akun Anda belum punya profil/peran di tabel <code>profiles</code>. Minta admin menambahkannya (lihat PANDUAN_DEPLOYMENT.md bagian "Kelola Pengguna").</div>`;
    await supabase.auth.signOut();
    return;
  }
  currentProfile = profile;
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appScreen').style.display = 'block';
  document.getElementById('userEmailLabel').textContent = currentUser.email;
  document.getElementById('userRoleBadge').textContent = profile.role;
  document.getElementById('arsipScopeHint').textContent =
    (profile.role === 'koder')
      ? 'Anda melihat klaim yang Anda buat sendiri. Verifikator/admin dapat melihat seluruh klaim.'
      : 'Anda login sebagai ' + profile.role + ' — dapat melihat seluruh klaim RS.';
  updateChecklist();
  toggleKelasBpjs();
  renderArsip();
  renderSkrining();
  renderDashboard();
}

async function doLogin(){
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('btnLogin');
  const label = document.getElementById('loginBtnLabel');
  const errBox = document.getElementById('loginErrBox');
  errBox.innerHTML = '';
  if(!email || !password){ errBox.innerHTML = '<div class="err">Isi email dan kata sandi.</div>'; return; }
  btn.disabled = true; label.innerHTML = '<span class="spinner"></span> Masuk...';
  try{
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if(error) throw error;
    await onLoggedIn(data.session);
  }catch(err){
    errBox.innerHTML = `<div class="err">Gagal masuk: ${esc(err.message || err)}</div>`;
  }finally{
    btn.disabled = false; label.textContent = 'Masuk';
  }
}

async function doLogout(){
  await supabase.auth.signOut();
  currentUser = null; currentProfile = null;
  showLogin();
}

// ---------------------------------------------------------------------
// UI kecil-kecil (tab, toggle, format)
// ---------------------------------------------------------------------
function esc(s){ if(s===undefined||s===null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtRp(n){ return (n===null||n===undefined||isNaN(n)) ? '—' : 'Rp' + Math.round(n).toLocaleString('id-ID'); }
function normCode(s){ return (s||'').toString().toUpperCase().trim(); }

function switchTab(name){
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab===name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-'+name));
  if(name==='arsip') renderArsip();
  if(name==='skrining') renderSkrining();
  if(name==='dashboard') renderDashboard();
}

function toggleKelasBpjs(){
  const jenis = document.getElementById('f_jenis').value;
  document.getElementById('kelasBpjsWrap').style.display = jenis === 'Rawat Inap' ? 'grid' : 'none';
}

function toggleReadmisiFields(){
  document.getElementById('readmisiFields').style.display = document.getElementById('f_readmisi').checked ? 'block' : 'none';
}

let icdJenisAktif = 'dx';
function switchIcdJenis(name){
  icdJenisAktif = name;
  document.querySelectorAll('[data-icd]').forEach(b => b.classList.toggle('active', b.dataset.icd===name));
  renderIcdSearchResults();
}

let tarifJenisAktif = 'ranap';
let tarifTerpilih = null; // {kode, deskripsi, tarif}
function switchTarifJenis(name){
  tarifJenisAktif = name;
  document.querySelectorAll('[data-tj]').forEach(b => b.classList.toggle('active', b.dataset.tj===name));
  renderTarifSearchResults();
}

function switchPT(name){
  document.querySelectorAll('[data-pt]').forEach(b => b.classList.toggle('active', b.dataset.pt===name));
  document.querySelectorAll('.pt-panel').forEach(p => p.classList.toggle('active', p.id === 'pt-'+name));
}

// ---------------------------------------------------------------------
// PENCARIAN KODE ICD-10 / ICD-9-CM (dulu: array lokal -> sekarang: query DB)
// ---------------------------------------------------------------------
let icdSearchTimer = null;
function renderIcdSearchResults(){
  clearTimeout(icdSearchTimer);
  const q = document.getElementById('f_icd_search').value.trim();
  const el = document.getElementById('icdSearchResults');
  if(q.length < 2){ el.innerHTML = '<p class="hint" style="text-align:center;">Ketik minimal 2 huruf.</p>'; return; }
  el.innerHTML = '<p class="hint" style="text-align:center;">Mencari...</p>';
  icdSearchTimer = setTimeout(async () => {
    const table = icdJenisAktif === 'dx' ? 'icd10_codes' : 'icd9cm_codes';
    const { data, error } = await supabase.from(table).select('kode,deskripsi')
      .or(`kode.ilike.%${q}%,deskripsi.ilike.%${q}%`)
      .order('kode').limit(30);
    if(error){ el.innerHTML = `<p class="err">Gagal mencari: ${esc(error.message)}</p>`; return; }
    if(!data || !data.length){ el.innerHTML = '<p class="hint" style="text-align:center;">Tidak ditemukan.</p>'; return; }
    el.innerHTML = `<table class="codes"><tr><th style="width:85px;">Kode</th><th>Deskripsi</th></tr>${
      data.map(r => `<tr><td><span class="code-chip">${esc(r.kode)}</span></td><td>${esc(r.deskripsi)}</td></tr>`).join('')
    }</table>${data.length>=30 ? '<p class="hint" style="margin-top:6px;">Menampilkan 30 hasil pertama — persempit kata kunci untuk hasil lebih spesifik.</p>' : ''}`;
  }, 300);
}

// ---------------------------------------------------------------------
// PENCARIAN TARIF RESMI + BENCHMARK RIIL RS
// ---------------------------------------------------------------------
let tarifSearchTimer = null;
function renderTarifSearchResults(){
  clearTimeout(tarifSearchTimer);
  const q = document.getElementById('f_tarif_search').value.trim();
  const el = document.getElementById('tarifSearchResults');
  if(q.length < 2){ el.innerHTML = '<p class="hint" style="text-align:center;">Ketik minimal 2 huruf.</p>'; return; }
  el.innerHTML = '<p class="hint" style="text-align:center;">Mencari...</p>';
  tarifSearchTimer = setTimeout(async () => {
    const table = tarifJenisAktif === 'ranap' ? 'tarif_ranap' : 'tarif_rajal';
    const { data, error } = await supabase.from(table).select('*')
      .or(`kode.ilike.%${q}%,deskripsi.ilike.%${q}%`)
      .order('kode').limit(30);
    if(error){ el.innerHTML = `<p class="err">Gagal mencari: ${esc(error.message)}</p>`; return; }
    if(!data || !data.length){ el.innerHTML = '<p class="hint" style="text-align:center;">Tidak ditemukan.</p>'; return; }

    const kodeList = data.map(r=>r.kode);
    const jenisBenchmark = tarifJenisAktif === 'ranap' ? 'RANAP' : 'RAJAL';
    const { data: bench } = await supabase.from('benchmark_riil_rs').select('*')
      .in('kode', kodeList).eq('jenis', jenisBenchmark);
    const benchMap = new Map((bench||[]).map(b => [b.kode, b]));

    window._tarifSearchRows = data; // dipakai pakaiTarif() lewat index, hindari inline-JSON di onclick
    el.innerHTML = data.map((r,idx) => {
      const b = benchMap.get(r.kode);
      let benchHtml = '';
      if(b){
        benchHtml = `<div class="ts-nums">📊 Benchmark RS aktual (${b.jumlah_klaim} klaim, ${b.periode||'periode tersedia'}): rata-rata biaya riil ${fmtRp(b.avg_tarif_riil_rs)} (selisih ${fmtRp(b.avg_tarif_riil_rs - b.avg_tarif_inacbg)} dari tarif INA-CBG), rata-rata LOS ${b.avg_los_hari} hari.</div>`;
      }
      return `<div class="ts-row">
        <div class="ts-info">
          <div class="ts-desk"><span class="code-chip">${esc(r.kode)}</span> ${esc(r.deskripsi)}</div>
          <div class="ts-nums">${tarifJenisAktif==='ranap' ? `Kelas 3: ${fmtRp(r.tarif_kelas3)} · Kelas 2: ${fmtRp(r.tarif_kelas2)} · Kelas 1: ${fmtRp(r.tarif_kelas1)}` : `Tarif: ${fmtRp(r.tarif)}`}</div>
          ${benchHtml}
        </div>
        <button type="button" class="ts-use" onclick="pakaiTarif(window._tarifSearchRows[${idx}], '${tarifJenisAktif}')">Pakai</button>
      </div>`;
    }).join('');
  }, 300);
}

function pakaiTarif(row, jenis){
  tarifTerpilih = { kode: row.kode, deskripsi: row.deskripsi };
  const kelas = document.getElementById('f_kelas_bpjs') ? document.getElementById('f_kelas_bpjs').value : '3';
  let tarif;
  if(jenis === 'ranap'){
    tarif = kelas==='1' ? row.tarif_kelas1 : (kelas==='2' ? row.tarif_kelas2 : row.tarif_kelas3);
  } else {
    tarif = row.tarif;
  }
  tarifTerpilih.tarif = tarif;
  document.getElementById('f_tarif_aktual').value = tarif || '';
  document.getElementById('tarifTerpilihBadge').innerHTML =
    `<div class="tarif-badge"><span class="code-chip">${esc(row.kode)}</span>${esc(row.deskripsi)} — <strong>${fmtRp(tarif)}</strong></div>`;
}

// ---------------------------------------------------------------------
// CHECKLIST KELENGKAPAN BERKAS (logika sama seperti v1 — murni client-side)
// ---------------------------------------------------------------------
const CHECKLIST_ITEMS = [
  {id:'sep', kategori:'Administratif', label:'SEP (Surat Eligibilitas Peserta) aktif & sesuai jenis pelayanan', critical:true, cond:()=>true},
  {id:'identitas', kategori:'Administratif', label:'Fotokopi/scan KTP & Kartu JKN-KIS peserta', critical:true, cond:()=>true},
  {id:'rujukan', kategori:'Administratif', label:'Surat rujukan berjenjang (FKTP/spesialis lain)', critical:false, cond:(c)=>c.jenis==='Rawat Jalan'},
  {id:'resume', kategori:'Rekam Medis', label:'Resume medis lengkap & ditandatangani DPJP', critical:true, cond:()=>true},
  {id:'assessment', kategori:'Rekam Medis', label:'Assessment awal medis & keperawatan', critical:true, cond:()=>true},
  {id:'cppt', kategori:'Rekam Medis', label:'CPPT (Catatan Perkembangan Pasien Terintegrasi) terisi lengkap', critical:true, cond:(c)=>c.jenis==='Rawat Inap'},
  {id:'lab_lampir', kategori:'Penunjang', label:'Hasil laboratorium dilampirkan', critical:false, cond:(c)=>c.adaLab},
  {id:'rad_lampir', kategori:'Penunjang', label:'Hasil radiologi dilampirkan', critical:false, cond:(c)=>c.adaRad},
  {id:'pa_lampir', kategori:'Penunjang', label:'Hasil PA/histopatologi dilampirkan (bila ada tindakan operatif/onkologi)', critical:false, cond:(c)=>c.adaTindakan},
  {id:'lapor_op', kategori:'Tindakan', label:'Laporan operasi lengkap & ditandatangani operator', critical:true, cond:(c)=>c.adaTindakan},
  {id:'anestesi', kategori:'Tindakan', label:'Laporan anestesi (bila General Anesthesia)', critical:false, cond:(c)=>c.adaTindakan},
  {id:'informed_consent', kategori:'Tindakan', label:'Informed consent tindakan', critical:true, cond:(c)=>c.adaTindakan},
  {id:'bukti_readmisi', kategori:'Kasus Khusus', label:'Bukti pendukung/justifikasi klinis readmisi <5 hari', critical:true, cond:(c)=>c.readmisi},
  {id:'protokol_khusus', kategori:'Kasus Khusus', label:'Protokol terapi khusus (kemoterapi/dialisis/dll) bila relevan', critical:false, cond:(c)=>c.adaTindakan},
  {id:'bukti_tarif_tinggi', kategori:'Kasus Khusus', label:'Bukti pendukung ekstra untuk kasus severity III / tarif tinggi (special CMG)', critical:true, cond:(c)=>c.severityTinggi},
];
let checklistState = {};

function checklistContext(){
  return {
    jenis: document.getElementById('f_jenis').value,
    adaLab: !!document.getElementById('f_lab').value.trim(),
    adaRad: !!document.getElementById('f_radiologi').value.trim(),
    adaTindakan: !!document.getElementById('f_tindakan').value.trim(),
    readmisi: document.getElementById('f_readmisi').checked,
    severityTinggi: lastResult && lastResult.severity_sesudah === 'III',
  };
}

function updateChecklist(){
  const ctx = checklistContext();
  const relevant = CHECKLIST_ITEMS.filter(it => it.cond(ctx));
  const cats = [...new Set(relevant.map(it=>it.kategori))];
  let body = '';
  cats.forEach(cat=>{
    body += `<div class="chk-cat">${esc(cat)}</div>`;
    relevant.filter(it=>it.kategori===cat).forEach(it=>{
      const checked = checklistState[it.id] ? 'checked' : '';
      body += `<div class="chk-item ${it.critical?'critical':''}">
        <input type="checkbox" id="chk_${it.id}" ${checked} onchange="onChecklistToggle('${it.id}')">
        <label for="chk_${it.id}">${esc(it.label)}${it.critical?' <span class="hint">(wajib)</span>':''}</label>
      </div>`;
    });
  });
  document.getElementById('checklistBody').innerHTML = body || '<p class="hint">Isi data kasus untuk memunculkan checklist.</p>';
  const total = relevant.length;
  const done = relevant.filter(it=>checklistState[it.id]).length;
  const pct = total ? Math.round((done/total)*100) : 0;
  document.getElementById('checklistProgress').innerHTML = `
    <div class="chk-progress-bar"><div class="chk-progress-fill" style="width:${pct}%;"></div></div>
    <div class="chk-progress-label"><span>${done} / ${total} item terpenuhi</span><span>${pct}%</span></div>
  `;
}
function onChecklistToggle(id){
  checklistState[id] = document.getElementById('chk_'+id).checked;
  updateChecklist();
}

// ---------------------------------------------------------------------
// RED-FLAG RULE ENGINE (deterministik, sama seperti v1 — murni client-side)
// ---------------------------------------------------------------------
function parseDate(s){ if(!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; }
function daysBetween(a,b){ return Math.round((b-a)/(1000*60*60*24)); }

function computeRedFlagsDeterministic(input, aiResult){
  const flags = [];
  const masuk = parseDate(input.tgl_masuk);
  const keluar = parseDate(input.tgl_keluar);
  if(input.jenis === 'Rawat Inap' && masuk && keluar){
    const los = daysBetween(masuk, keluar);
    if(los < 0){
      flags.push({flag:'Tanggal keluar lebih awal dari tanggal masuk — periksa kembali input tanggal.', tingkat:'Sedang', saran:'Perbaiki tanggal masuk/keluar sebelum klaim diajukan.'});
    } else {
      const ranges = {I:[1,4], II:[3,7], III:[5,14]};
      const sev = aiResult ? aiResult.severity_sesudah : null;
      const r = ranges[sev];
      if(r && (los < r[0] || los > r[1])){
        flags.push({ flag:`Lama rawat (LOS) ${los} hari berada di luar perkiraan umum untuk Severity ${sev} (perkiraan ${r[0]}–${r[1]} hari).`, tingkat:'Sedang',
          saran:'Siapkan justifikasi klinis di CPPT/resume medis atas lama rawat ini agar tidak dipertanyakan verifikator.' });
      } else if(!r && los > 14){
        flags.push({flag:`Lama rawat (LOS) ${los} hari tergolong panjang.`, tingkat:'Rendah', saran:'Pastikan alasan perpanjangan rawat terdokumentasi jelas di CPPT.'});
      }
    }
  }
  if(input.readmisi){
    const prevKeluar = parseDate(input.tgl_pulang_prev);
    let jarakHari = null;
    if(prevKeluar && masuk) jarakHari = daysBetween(prevKeluar, masuk);
    flags.push({ flag: `Kasus ditandai sebagai readmisi${jarakHari!==null ? ' ('+jarakHari+' hari dari rawat sebelumnya)' : ' <5 hari'} dengan diagnosis serupa (${input.dx_prev || 'tidak dicantumkan'}).`, tingkat:'Tinggi',
      saran:'Verifikator BPJS umumnya menelaah readmisi dini. Lampirkan bukti pendukung (rencana readmisi terjadwal, komplikasi baru, dll).' });
  }
  if(aiResult && aiResult.severity_sesudah === 'III'){
    flags.push({ flag:'Severity III (dengan MCC) — klaim bernilai relatif tinggi.', tingkat:'Sedang',
      saran:'Klaim severity tinggi biasanya mendapat perhatian lebih dari verifikator. Pastikan seluruh diagnosis CC/MCC didukung bukti eksplisit di rekam medis.' });
  }
  return flags;
}

function renderRedFlags(input, aiResult){
  const detFlags = computeRedFlagsDeterministic(input, aiResult);
  const aiFlags = (aiResult && aiResult.red_flags_klinis) ? aiResult.red_flags_klinis.map(f=>({flag:f.flag, tingkat:f.tingkat, saran:f.saran})) : [];
  const all = [...aiFlags, ...detFlags];
  if(!all.length) return `<div class="rf-empty">Tidak ada red-flag yang terdeteksi dari data yang diisi saat ini.</div>`;
  const order = {Tinggi:0, Sedang:1, Rendah:2};
  all.sort((a,b)=>(order[a.tingkat]??3)-(order[b.tingkat]??3));
  return all.map(f => `
    <div class="rf-item">
      <span class="rf-level ${esc(f.tingkat)}">${esc(f.tingkat)}</span>
      <div class="rf-text"><span class="rf-title">${esc(f.flag)}</span><span class="rf-saran">${esc(f.saran||'')}</span></div>
    </div>
  `).join('');
}

// ---------------------------------------------------------------------
// UNGGAH GAMBAR (sama seperti v1 — base64 di memori, dikirim ke gateway,
// TIDAK pernah ditulis ke database)
// ---------------------------------------------------------------------
let uploadedImages = []; // {name, mediaType, base64}
function handleImageUpload(evt){
  const files = Array.from(evt.target.files || []).slice(0, 4 - uploadedImages.length);
  files.forEach(file => {
    if(file.size > 5*1024*1024){ alert(`${file.name} lebih dari 5MB, dilewati.`); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      uploadedImages.push({name:file.name, mediaType:file.type, base64});
      renderImgGallery();
    };
    reader.readAsDataURL(file);
  });
  evt.target.value = '';
}
function removeImage(idx){ uploadedImages.splice(idx,1); renderImgGallery(); }
function renderImgGallery(){
  document.getElementById('imgGallery').innerHTML = uploadedImages.map((img,i) => `
    <div class="thumb"><img src="data:${img.mediaType};base64,${img.base64}"><button class="rm" onclick="removeImage(${i})">×</button></div>
  `).join('');
}
// ---------------------------------------------------------------------
// ANALISA AI — lewat gateway RS, bukan langsung ke Anthropic
// ---------------------------------------------------------------------
let lastResult = null;
let lastInput = null;

function readCaseInput(){
  return {
    rm: document.getElementById('f_rm').value.trim(),
    nama: document.getElementById('f_nama').value.trim(),
    jenis: document.getElementById('f_jenis').value,
    dpjp: document.getElementById('f_dpjp').value.trim(),
    status_klaim: document.getElementById('f_status_klaim').value,
    kelas_bpjs: document.getElementById('f_kelas_bpjs').value,
    usia: document.getElementById('f_usia').value ? parseInt(document.getElementById('f_usia').value) : null,
    jk: document.getElementById('f_jk').value,
    tgl_masuk: document.getElementById('f_tgl_masuk').value.trim(),
    tgl_keluar: document.getElementById('f_tgl_keluar').value.trim(),
    readmisi: document.getElementById('f_readmisi').checked,
    tgl_pulang_prev: document.getElementById('f_tgl_pulang_prev').value.trim(),
    dx_prev: document.getElementById('f_dx_prev').value.trim(),
    dx_utama: document.getElementById('f_dx_utama').value.trim(),
    dx_sek: document.getElementById('f_dx_sek').value.trim(),
    tindakan: document.getElementById('f_tindakan').value.trim(),
    klinis: document.getElementById('f_klinis').value.trim(),
    soap_s: document.getElementById('f_soap_s').value.trim(),
    soap_o: document.getElementById('f_soap_o').value.trim(),
    soap_a: document.getElementById('f_soap_a').value.trim(),
    soap_p: document.getElementById('f_soap_p').value.trim(),
    lab: document.getElementById('f_lab').value.trim(),
    radiologi: document.getElementById('f_radiologi').value.trim(),
    penunjang_lain: document.getElementById('f_penunjang_lain').value.trim(),
    n_gambar: uploadedImages.length,
  };
}

async function runAnalysis(){
  const errBox = document.getElementById('errBox');
  errBox.innerHTML = '';
  const input = readCaseInput();
  if(!input.dx_utama){ errBox.innerHTML = '<div class="err">Diagnosis utama wajib diisi.</div>'; return; }

  const tarifAktual = parseFloat(document.getElementById('f_tarif_aktual').value) || null;
  const tarifRiil = parseFloat(document.getElementById('f_tarif_riil').value) || null;

  const btn = document.getElementById('btnAnalyze');
  const label = document.getElementById('btnLabel');
  btn.disabled = true;
  label.innerHTML = '<span class="spinner"></span> Menganalisa...';

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(input);
  const contentBlocks = [];
  uploadedImages.forEach(img => contentBlocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } }));
  contentBlocks.push({ type: "text", text: userPrompt });

  try{
    // NOTE: request ini mengasumsikan gateway meneruskan body apa adanya ke
    // Anthropic (passthrough) dan mengembalikan response Anthropic asli.
    // Sesuaikan bentuk request/response di bawah ini kalau kontrak gateway
    // Anda yang sebenarnya berbeda.
    const headers = {"Content-Type": "application/json"};
    if(window.APP_CONFIG.GATEWAY_KEY && !window.APP_CONFIG.GATEWAY_KEY.startsWith('GANTI_')){
      headers["Authorization"] = "Bearer " + window.APP_CONFIG.GATEWAY_KEY;
    }
    const response = await fetch(window.APP_CONFIG.GATEWAY_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: "user", content: contentBlocks }]
      })
    });
    if(!response.ok) throw new Error('Permintaan ke gateway gagal (status ' + response.status + '). Cek apakah GATEWAY_URL di config.js sudah benar dan gateway sedang aktif.');
    const data = await response.json();
    const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    let clean = textBlocks.trim().replace(/^```json/i,'').replace(/^```/,'').replace(/```$/,'').trim();
    let parsed;
    try{ parsed = JSON.parse(clean); }
    catch(e){
      const match = clean.match(/\{[\s\S]*\}/);
      if(match){ parsed = JSON.parse(match[0]); } else { throw new Error('Format respons AI tidak sesuai, coba lagi.'); }
    }

    // Validasi kode yang diusulkan AI terhadap database resmi (sekarang lewat query,
    // dilakukan sekali per hasil analisa dan disimpan di cache map di memori).
    await primeCodeValidityCache(parsed);

    lastResult = parsed;
    lastInput = input;
    renderResult(parsed, {tarifAktual, tarifRiil}, input);
    updateChecklist();

    if(parsed.diagnosis_utama && parsed.diagnosis_utama.deskripsi){
      switchTarifJenis(input.jenis === 'Rawat Jalan' ? 'rajal' : 'ranap');
      const kw = parsed.diagnosis_utama.deskripsi.split(' ').slice(0,2).join(' ');
      document.getElementById('f_tarif_search').value = kw;
      renderTarifSearchResults();
    }
  }catch(err){
    console.error(err);
    errBox.innerHTML = `<div class="err">Terjadi kendala saat memproses analisa: ${esc(err.message||err)}. Silakan coba lagi.</div>`;
  }finally{
    btn.disabled = false;
    label.textContent = 'Analisa Koding + Tarif';
  }
}

let validIcd10Map = new Map();
let validIcd9Map = new Map();
async function primeCodeValidityCache(parsed){
  const dxCodes = [parsed.diagnosis_utama?.kode, ...((parsed.diagnosis_sekunder||[]).map(d=>d.kode))]
    .filter(Boolean).map(normCode);
  const pxCodes = (parsed.prosedur||[]).map(p=>p.kode).filter(Boolean).map(normCode);
  if(dxCodes.length){
    const { data } = await supabase.from('icd10_codes').select('kode,deskripsi').in('kode', [...new Set(dxCodes)]);
    validIcd10Map = new Map((data||[]).map(r=>[r.kode, r.deskripsi]));
  }
  if(pxCodes.length){
    const { data } = await supabase.from('icd9cm_codes').select('kode,deskripsi').in('kode', [...new Set(pxCodes)]);
    validIcd9Map = new Map((data||[]).map(r=>[r.kode, r.deskripsi]));
  }
}

function buildSystemPrompt(){
  return `Anda adalah spesialis koding klinis senior di rumah sakit Indonesia, ahli ICD-10 (WHO 2010) dan ICD-9-CM (2010), sekaligus memahami pola umum tarif INA-CBG untuk verifikasi klaim JKN/BPJS Kesehatan.

KONTEKS RS: RS Tipe C swasta, Regional 1 tarif INA-CBG (Jawa Tengah, termasuk wilayah dengan Banten/DKI Jakarta/Jawa Barat/DIY/Jawa Timur).

ANDA JUGA MENERIMA DATA PENUNJANG: hasil Laboratorium, Radiologi, dan Penunjang Lain (EKG/USG/PA/endoskopi/dll) yang ditempel terpisah oleh koder, catatan SOAP terstruktur (Subjective/Objective/Assessment/Plan), dan mungkin satu atau lebih GAMBAR terlampir (foto resume medis tulisan tangan, hasil rontgen/USG discan, hasil lab discan, dll). Ini sering memuat bukti obyektif untuk diagnosis sekunder yang belum sempat dikode (misal kalium rendah → hipokalemia, Hb rendah → anemia, hasil rontgen thorax dengan infiltrat → mendukung pneumonia, kreatinin tinggi + oliguria → cedera ginjal akut, hasil PA → diagnosis definitif pasca-operasi).

ATURAN KHUSUS GAMBAR: baca gambar yang dilampirkan seteliti mungkin. Jika tulisan tangan/hasil scan sulit dibaca atau ambigu, JANGAN menebak isinya — sebutkan di "rekomendasi_konfirmasi_dpjp" bahwa bagian tersebut perlu dikonfirmasi karena gambar kurang jelas. Jika sebuah diagnosis/temuan berasal jelas dari gambar (bukan dari teks lain yang sudah ada), tandai sumber "temuan_dokumen_foto" dan sebutkan di "catatan" bahwa temuan berasal dari gambar terlampir.

TUGAS:
1. Tentukan kode ICD-10 diagnosis utama.
2. Usulkan kode ICD-10 LENGKAP untuk seluruh diagnosis sekunder/komorbid, dan tandai field "sumber" salah satu dari:
   - "input_koder": sudah disebutkan koder di kolom diagnosis sekunder.
   - "temuan_klinis": tersirat jelas dari ringkasan klinis tambahan (bukan dari lab/radiologi/penunjang lain).
   - "temuan_laboratorium": didukung nilai lab yang jelas abnormal secara klinis dan relevan (sebutkan nilainya di "catatan").
   - "temuan_radiologi": didukung bacaan/kesan radiologi.
   - "temuan_penunjang_lain": didukung hasil EKG/USG/PA/endoskopi/dll.
   - "temuan_dokumen_foto": didukung isi gambar/foto yang dilampirkan.
   Tandai cc_mcc: "CC", "MCC", atau "-".
   ATURAN KHUSUS DATA PENUNJANG: hanya jadikan temuan lab sebagai diagnosis terkode bila nilainya SECARA JELAS di luar rentang rujukan normal yang dicantumkan/lazim DAN relevan secara klinis dengan kondisi pasien. Bila nilai hanya sedikit di luar rentang normal atau maknanya ambigu tanpa korelasi klinis yang jelas, JANGAN jadikan diagnosis pasti — masukkan ke "rekomendasi_konfirmasi_dpjp" saja.
3. Usulkan kode ICD-9-CM untuk tindakan/prosedur yang disebutkan.
4. Hitung DUA estimasi severity level INA-CBG (I/II/III):
   - "severity_sebelum": HANYA berdasarkan diagnosis utama + diagnosis sekunder/tindakan yang secara eksplisit disebutkan koder pada input (sumber "input_koder" saja).
   - "severity_sesudah": berdasarkan diagnosis utama + SEMUA diagnosis sekunder termasuk temuan_ai (koding lengkap).
5. Berikan estimasi RENTANG tarif INA-CBG (Rupiah, {"min":angka,"max":angka}) untuk RS Tipe C Regional 1 pada masing-masing severity di atas: "estimasi_tarif_sebelum" dan "estimasi_tarif_sesudah". Ini adalah PERKIRAAN KASAR berdasarkan pola umum (bukan lookup tabel resmi) — beri rentang yang wajar, jangan angka presisi palsu.
6. "temuan_potensi_kelengkapan": daftar objek {"temuan":"string","sumber":"Laboratorium|Radiologi|Penunjang Lain|Klinis|Gambar"} — kondisi yang tampak terdokumentasi (termasuk dari data penunjang) tapi belum dikode koder.
7. "rekomendasi_konfirmasi_dpjp": hal yang perlu dikonfirmasi karena dokumentasi (termasuk hasil penunjang yang ambigu) belum cukup spesifik untuk dikode dengan aman.
8. "catatan_umum": 1-3 kalimat ringkasan, termasuk penjelasan singkat kenapa severity_sesudah bisa berbeda dari severity_sebelum.
9. "red_flags_klinis": daftar objek {"flag":"string","tingkat":"Tinggi|Sedang|Rendah","saran":"string"} berisi potensi hal yang akan diperhatikan/dipertanyakan verifikator BPJS dari sisi KLINIS, khususnya:
   - Ketidaksesuaian usia dan/atau jenis kelamin pasien dengan diagnosis.
   - Prosedur/tindakan yang dicantumkan tapi tidak didukung diagnosis yang jelas mengindikasikannya.
   - Kombinasi diagnosis-prosedur yang secara klinis janggal atau butuh penjelasan tambahan.
   Jika tidak ada isu, kembalikan array kosong.

ATURAN KETAT:
- JANGAN PERNAH mengarang diagnosis/prosedur yang tidak berdasar dari teks input. Jika ragu, taruh di "rekomendasi_konfirmasi_dpjp".
- Tujuannya KELENGKAPAN & AKURASI berbasis dokumentasi klinis nyata (clinical documentation improvement) — BUKAN upcoding tanpa dasar.
- Estimasi tarif WAJIB berupa rentang (min-max) yang mencerminkan ketidakpastian, bukan angka tunggal presisi tinggi.
- Tulis semua output dalam Bahasa Indonesia.

FORMAT OUTPUT: HANYA JSON valid, tanpa teks lain, tanpa markdown fence:
{
  "diagnosis_utama": {"kode":"string","deskripsi":"string"},
  "diagnosis_sekunder": [{"kode":"string","deskripsi":"string","cc_mcc":"CC|MCC|-","sumber":"input_koder|temuan_klinis|temuan_laboratorium|temuan_radiologi|temuan_penunjang_lain|temuan_dokumen_foto","catatan":"string"}],
  "prosedur": [{"kode":"string","deskripsi":"string","catatan":"string"}],
  "severity_sebelum": "I|II|III",
  "severity_sesudah": "I|II|III",
  "estimasi_tarif_sebelum": {"min":number,"max":number},
  "estimasi_tarif_sesudah": {"min":number,"max":number},
  "temuan_potensi_kelengkapan": [{"temuan":"string","sumber":"Laboratorium|Radiologi|Penunjang Lain|Klinis|Gambar"}],
  "rekomendasi_konfirmasi_dpjp": ["string"],
  "red_flags_klinis": [{"flag":"string","tingkat":"Tinggi|Sedang|Rendah","saran":"string"}],
  "catatan_umum": "string"
}`;
}

function buildUserPrompt(input){
  return `DATA KASUS:
No. RM: ${input.rm || '(tidak diisi)'}
Jenis Pelayanan: ${input.jenis}
Usia Pasien: ${input.usia || '(tidak diisi)'} tahun
Jenis Kelamin: ${input.jk || '(tidak diisi)'}
Tanggal Masuk: ${input.tgl_masuk || '(tidak diisi)'}
Tanggal Keluar: ${input.tgl_keluar || '(tidak diisi)'}
Readmisi <5 hari dengan diagnosis serupa: ${input.readmisi ? `YA (rawat sebelumnya pulang ${input.tgl_pulang_prev||'(tanggal tidak diisi)'}, diagnosis: ${input.dx_prev||'(tidak diisi)'})` : 'Tidak'}

Diagnosis Utama:
${input.dx_utama}

Diagnosis Sekunder / Komorbid (input koder):
${input.dx_sek || '(tidak diisi)'}

Tindakan / Prosedur (input koder):
${input.tindakan || '(tidak diisi)'}

Ringkasan Klinis Tambahan (teks bebas):
${input.klinis || '(tidak diisi)'}

Catatan SOAP Terstruktur:
S (Subjective): ${input.soap_s || '(tidak diisi)'}
O (Objective): ${input.soap_o || '(tidak diisi)'}
A (Assessment): ${input.soap_a || '(tidak diisi)'}
P (Plan): ${input.soap_p || '(tidak diisi)'}

Hasil Laboratorium:
${input.lab || '(tidak diisi)'}

Hasil Radiologi:
${input.radiologi || '(tidak diisi)'}

Hasil Penunjang Lain (EKG/USG/PA/endoskopi/dll):
${input.penunjang_lain || '(tidak diisi)'}

${input.n_gambar > 0 ? `Terlampir ${input.n_gambar} gambar pendukung (foto resume medis/hasil penunjang) — lihat gambar yang disertakan dalam pesan ini.` : ''}

Telaah kasus ini sesuai instruksi sistem dan kembalikan hanya JSON sesuai format yang ditentukan.`;
}

// ---------------------------------------------------------------------
// RENDER HASIL ANALISA
// ---------------------------------------------------------------------
const SRC_MAP = {
  'input_koder': {cls:'baseline', label:'Input Koder'},
  'temuan_klinis': {cls:'temuan', label:'Temuan Klinis'},
  'temuan_ai': {cls:'temuan', label:'Temuan AI'},
  'temuan_laboratorium': {cls:'src-lab', label:'Temuan Lab'},
  'temuan_radiologi': {cls:'src-rad', label:'Temuan Radiologi'},
  'temuan_penunjang_lain': {cls:'src-penunjang', label:'Temuan Penunjang'},
  'temuan_dokumen_foto': {cls:'src-foto', label:'Temuan dari Gambar'},
};
function srcBadge(sumber){ const m = SRC_MAP[sumber]; return m ? `<span class="tag ${m.cls}">${esc(m.label)}</span>` : ''; }

function validityBadge(kode, kind){
  if(!kode) return '';
  const map = kind==='dx' ? validIcd10Map : validIcd9Map;
  const found = map.get(normCode(kode));
  if(found){
    return `<div class="valid-line"><span class="tag valid-code" title="Deskripsi resmi: ${esc(found)}">✓ Terverifikasi ${kind==='dx'?'ICD-10':'ICD-9-CM'}</span></div>`;
  }
  return `<div class="valid-line"><span class="tag invalid-code" title="Kode tidak ditemukan persis di database RS — cek manual, bisa jadi kode turunan/format berbeda">⚠ Cek manual — tidak ditemukan di database</span></div>`;
}

function codeRows(list, kind){
  if(!list || !list.length) return `<tr><td colspan="4" style="color:#8FA0AF;font-size:12px;">Tidak ada usulan tambahan.</td></tr>`;
  return list.map(item => {
    let tag = `<span class="tag none">—</span>`;
    if(kind==='dx' && item.cc_mcc && item.cc_mcc !== '-' && item.cc_mcc.toUpperCase()!=='NONE'){
      tag = `<span class="tag ${item.cc_mcc.toLowerCase()==='mcc'?'mcc':'cc'}">${esc(item.cc_mcc)}</span>`;
    }
    const src = (kind==='dx' && item.sumber) ? srcBadge(item.sumber) : '';
    const valid = validityBadge(item.kode, kind);
    return `<tr><td><span class="code-chip">${esc(item.kode||'—')}</span></td><td>${esc(item.deskripsi||'')}<div style="margin-top:3px;">${src}</div>${valid}</td><td>${tag}</td><td style="color:#5C6E80;">${esc(item.catatan||'')}</td></tr>`;
  }).join('');
}

function sevInfo(level){
  const map = {'I':{label:'Severity I — Ringan'},'II':{label:'Severity II — Sedang (CC)'},'III':{label:'Severity III — Berat (MCC)'}};
  return map[level] || {label:'Severity I — Ringan'};
}
function tarifRange(est){
  if(!est) return null;
  const min = Number(est.min), max = Number(est.max);
  if(isNaN(min)||isNaN(max)) return null;
  return {min, max, mid:(min+max)/2};
}
function penunjangBadges(input){
  const items = [
    ['Laboratorium', input.lab], ['Radiologi', input.radiologi], ['Penunjang Lain', input.penunjang_lain],
    ['SOAP', (input.soap_s||input.soap_o||input.soap_a||input.soap_p) ? 'x' : ''],
    ['Gambar', input.n_gambar>0 ? `${input.n_gambar} file` : '']
  ];
  return items.map(([label, val]) => {
    const has = val && String(val).trim().length>0;
    return `<span class="tag ${has?'temuan':'none'}" style="margin-right:6px;">${has?'✓ ':'– '}${esc(label)}</span>`;
  }).join('');
}

function renderResult(data, manual, inputUsed){
  const before = tarifRange(data.estimasi_tarif_sebelum);
  const after = tarifRange(data.estimasi_tarif_sesudah);
  const afterVal = manual.tarifAktual ? {min:manual.tarifAktual,max:manual.tarifAktual,mid:manual.tarifAktual} : after;
  const upliftMid = (afterVal && before) ? (afterVal.mid - before.mid) : null;

  let impactHtml = '';
  if(before && afterVal){
    impactHtml = `
      <div class="impact-grid">
        <div class="impact-box"><div class="impact-label">Sebelum (input koder)</div><div class="impact-sev">${esc(sevInfo(data.severity_sebelum).label)}</div>
          <div class="impact-tarif">${fmtRp(before.mid)}<br><small>perkiraan ${fmtRp(before.min)}–${fmtRp(before.max)}</small></div></div>
        <div class="impact-arrow">→</div>
        <div class="impact-box after"><div class="impact-label">${manual.tarifAktual ? 'Setelah — Tarif Aktual e-Klaim' : 'Setelah kelengkapan (usulan AI)'}</div><div class="impact-sev">${esc(sevInfo(data.severity_sesudah).label)}</div>
          <div class="impact-tarif">${fmtRp(afterVal.mid)}${manual.tarifAktual ? '' : `<br><small>perkiraan ${fmtRp(afterVal.min)}–${fmtRp(afterVal.max)}</small>`}</div></div>
      </div>
      <div class="uplift-banner"><span class="lbl">Potensi selisih tarif dari kelengkapan koding (per kasus)</span><span class="amt">${upliftMid>=0?'+':''}${fmtRp(upliftMid)}</span></div>
    `;
  } else {
    impactHtml = `<p style="font-size:12.5px;color:#8FA0AF;">AI tidak dapat menghitung perkiraan tarif untuk kasus ini.</p>`;
  }

  let compareHtml = '';
  if(manual.tarifRiil){
    const acuan = afterVal ? afterVal.mid : null;
    const selisih = acuan!==null ? acuan - manual.tarifRiil : null;
    const pct = acuan ? selisih/acuan : 0;
    let status = 'impas', statusLabel = 'IMPAS';
    if(pct>0.05){status='surplus'; statusLabel='SURPLUS';} else if(pct<-0.05){status='defisit'; statusLabel='DEFISIT';}
    compareHtml = `<div class="compare-real ${status}">
      <div class="cr-row"><span>Tarif INA-CBG (${manual.tarifAktual?'aktual e-Klaim':'perkiraan setelah kelengkapan'})</span><span>${fmtRp(acuan)}</span></div>
      <div class="cr-row"><span>Tarif Riil / Unit Cost RS</span><span>${fmtRp(manual.tarifRiil)}</span></div>
      <div class="cr-row total"><span>Selisih</span><span>${selisih>=0?'+':''}${fmtRp(selisih)} &nbsp;<span class="status-pill ${status}">${statusLabel}</span></span></div>
    </div>`;
  }

  const html = `
    ${inputUsed ? `<div style="margin-bottom:14px;">${penunjangBadges(inputUsed)}</div>` : ''}
    <div class="section-title">Red-Flag Risiko Verifikasi BPJS</div>
    ${renderRedFlags(inputUsed||{}, data)}
    <div class="section-title">Dampak Kelengkapan Koding terhadap Severity &amp; Tarif</div>
    ${impactHtml}
    ${manual.tarifRiil ? `<div class="section-title">Perbandingan dengan Tarif Riil RS</div>${compareHtml}` : ''}
    ${data.catatan_umum ? `<p style="font-size:12.5px;color:#33475A;line-height:1.55;margin-top:14px;">${esc(data.catatan_umum)}</p>` : ''}
    <div class="section-title">Diagnosis Utama</div>
    <table class="codes"><tr><td><span class="code-chip">${esc(data.diagnosis_utama?.kode||'—')}</span></td><td colspan="3">${esc(data.diagnosis_utama?.deskripsi||'')}${validityBadge(data.diagnosis_utama?.kode,'dx')}</td></tr></table>
    <div class="section-title">Diagnosis Sekunder / Komorbid (ICD-10) — lengkap</div>
    <table class="codes"><tr><th style="width:85px;">Kode</th><th>Deskripsi &amp; Sumber</th><th style="width:60px;">CC/MCC</th><th>Catatan</th></tr>${codeRows(data.diagnosis_sekunder,'dx')}</table>
    <div class="section-title">Tindakan / Prosedur (ICD-9-CM)</div>
    <table class="codes"><tr><th style="width:85px;">Kode</th><th>Deskripsi</th><th style="width:60px;"></th><th>Catatan</th></tr>${codeRows(data.prosedur,'px')}</table>
    <div class="section-title">Temuan Terdokumentasi Namun Berpotensi Belum Dikode</div>
    <ul class="findings">${(data.temuan_potensi_kelengkapan||[]).map(t=>{
      const teks = typeof t === 'string' ? t : (t.temuan||'');
      const badge = typeof t === 'object' && t.sumber ? `<span class="tag ${ {Laboratorium:'src-lab',Radiologi:'src-rad','Penunjang Lain':'src-penunjang',Klinis:'temuan',Gambar:'src-foto'}[t.sumber] || 'temuan' }" style="margin-right:6px;">${esc(t.sumber)}</span>` : '';
      return `<li><span class="dot"></span><span>${badge}${esc(teks)}</span></li>`;
    }).join('') || '<li style="color:#8FA0AF;">Tidak ada temuan tambahan.</li>'}</ul>
    <div class="section-title">Rekomendasi Konfirmasi ke DPJP <span style="text-transform:none;letter-spacing:0;">(query koder)</span></div>
    <ul class="findings query">${(data.rekomendasi_konfirmasi_dpjp||[]).map(t=>`<li><span class="dot"></span><span>${esc(t)}</span></li>`).join('') || '<li style="color:#8FA0AF;">Tidak ada item yang perlu dikonfirmasi.</li>'}</ul>
    <div class="disclaimer"><strong>Catatan penting:</strong> Nilai pada kartu "Sebelum/Sesudah" adalah <u>perkiraan kasar AI</u>, bukan hasil grouper resmi. Untuk angka resmi, gunakan kartu "Cari Tarif Resmi INA-CBG". Hasil grouping final tetap harus diverifikasi lewat Aplikasi INA-CBG/e-Klaim RS. Kode yang diusulkan wajib diverifikasi koder tersertifikasi terhadap rekam medis asli sebelum diklaimkan ke BPJS.</div>
    <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <button class="ghost" id="btnSaveCase" onclick="saveCase()">Simpan kasus ini</button>
      <button class="ghost" onclick="window.print()">Cetak / PDF</button>
      <span id="saveCaseStatus" style="font-size:12px;"></span>
    </div>
  `;
  document.getElementById('resultBody').innerHTML = html;
}
// ---------------------------------------------------------------------
// SIMPAN KASUS -> Supabase (claims + ai_results), lalu recompute skrining
// ---------------------------------------------------------------------
let editingClaimId = null; // diisi kalau sedang membuka ulang kasus tersimpan

async function saveCase(){
  const statusEl = document.getElementById('saveCaseStatus');
  const btn = document.getElementById('btnSaveCase');
  const setStatus = (msg, isError) => { statusEl.textContent = msg; statusEl.style.color = isError ? 'var(--red)' : 'var(--teal)'; };
  if(!lastResult || !lastInput){ setStatus('Belum ada hasil analisa AI untuk disimpan.', true); return; }
  btn.disabled = true; setStatus('Menyimpan...', false);

  const i = lastInput;
  const claimRow = {
    no_rm: i.rm || null, nama_pasien: i.nama || null, jenis_pelayanan: i.jenis, dpjp: i.dpjp || null,
    status_klaim: i.status_klaim, kelas_bpjs: i.jenis==='Rawat Inap' ? i.kelas_bpjs : null,
    usia: i.usia, jenis_kelamin: i.jk || null,
    tgl_masuk: i.tgl_masuk || null, tgl_keluar: i.tgl_keluar || null,
    readmisi: i.readmisi, tgl_pulang_prev: i.tgl_pulang_prev || null, dx_prev: i.dx_prev || null,
    dx_utama: i.dx_utama, dx_sekunder: i.dx_sek || null, tindakan: i.tindakan || null, klinis: i.klinis || null,
    soap_s: i.soap_s || null, soap_o: i.soap_o || null, soap_a: i.soap_a || null, soap_p: i.soap_p || null,
    lab: i.lab || null, radiologi: i.radiologi || null, penunjang_lain: i.penunjang_lain || null,
    tarif_aktual: parseFloat(document.getElementById('f_tarif_aktual').value) || null,
    tarif_riil: parseFloat(document.getElementById('f_tarif_riil').value) || null,
    tarif_terpilih: tarifTerpilih, checklist_state: checklistState,
    created_by: currentUser.id,
  };

  try{
    let claimId = editingClaimId;
    if(claimId){
      const { error } = await supabase.from('claims').update(claimRow).eq('id', claimId);
      if(error) throw error;
      await supabase.from('ai_results').update({ is_current: false }).eq('claim_id', claimId).eq('is_current', true);
    } else {
      const { data, error } = await supabase.from('claims').insert(claimRow).select('id').single();
      if(error) throw error;
      claimId = data.id;
    }

    const r = lastResult;
    const { error: aiErr } = await supabase.from('ai_results').insert({
      claim_id: claimId,
      diagnosis_utama: r.diagnosis_utama, diagnosis_sekunder: r.diagnosis_sekunder, prosedur: r.prosedur,
      severity_sebelum: r.severity_sebelum, severity_sesudah: r.severity_sesudah,
      estimasi_tarif_sebelum: r.estimasi_tarif_sebelum, estimasi_tarif_sesudah: r.estimasi_tarif_sesudah,
      temuan_potensi_kelengkapan: r.temuan_potensi_kelengkapan, rekomendasi_konfirmasi_dpjp: r.rekomendasi_konfirmasi_dpjp,
      red_flags_klinis: r.red_flags_klinis, catatan_umum: r.catatan_umum, model_used: 'claude-sonnet-4-6', is_current: true,
    });
    if(aiErr) throw aiErr;

    await supabase.rpc('recompute_screening_flags');

    editingClaimId = claimId;
    setStatus('Tersimpan.', false);
    renderArsip(); renderSkrining(); renderDashboard();
  }catch(err){
    console.error(err);
    setStatus('Gagal menyimpan: ' + (err.message||err), true);
  }finally{
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------
// ARSIP PASIEN
// ---------------------------------------------------------------------
async function fetchAllClaimsWithResult(){
  // RLS otomatis membatasi baris yang kembali sesuai peran (lihat 02_rls.sql):
  // koder hanya melihat miliknya sendiri, verifikator/admin melihat semua.
  const { data, error } = await supabase.from('claims')
    .select('*, ai_results!inner(*)')
    .eq('ai_results.is_current', true)
    .order('created_at', { ascending: false });
  if(error){ console.error(error); return []; }
  return data.map(c => ({ ...c, ai: c.ai_results[0] }));
}

function statusClass(status){ return (status||'Draft').replace(/\s+/g,''); }

async function renderArsip(){
  const body = document.getElementById('arsipBody');
  const rows = await fetchAllClaimsWithResult();
  window._allClaims = rows;

  const counts = {};
  rows.forEach(r => counts[r.status_klaim] = (counts[r.status_klaim]||0)+1);
  document.getElementById('arsipStatusCounts').innerHTML = Object.entries(counts)
    .map(([s,n]) => `<span class="arsip-count"><span class="status-chip ${statusClass(s)}">${esc(s)}</span> ${n}</span>`).join('');

  const q = (document.getElementById('f_arsip_search').value||'').toLowerCase();
  const filterStatus = document.getElementById('f_arsip_status').value;
  const filtered = rows.filter(r => {
    if(filterStatus && r.status_klaim !== filterStatus) return false;
    if(!q) return true;
    return [r.no_rm, r.nama_pasien, r.dx_utama].some(v => (v||'').toLowerCase().includes(q));
  });

  if(!filtered.length){ body.innerHTML = '<div class="empty"><div class="glyph">⌂</div><p>Belum ada kasus yang cocok.</p></div>'; return; }

  body.innerHTML = `<table class="arsip"><tr><th>No. RM</th><th>Pasien</th><th>Diagnosis</th><th>DPJP</th><th>Severity</th><th>Status</th><th></th></tr>
    ${filtered.map(r => `<tr>
      <td>${esc(r.no_rm||'—')}</td><td>${esc(r.nama_pasien||'—')}</td><td>${esc(r.dx_utama)}</td><td>${esc(r.dpjp||'—')}</td>
      <td>${esc(r.ai?.severity_sesudah||'—')}</td>
      <td><select class="status-select" onchange="updateStatusKlaim('${r.id}', this.value)">
        ${['Draft','Siap Verifikasi Internal','Diajukan ke BPJS','Disetujui','Dispute','Ditolak'].map(s=>`<option value="${s}" ${s===r.status_klaim?'selected':''}>${s}</option>`).join('')}
      </select></td>
      <td><button class="arsip-open" onclick="reopenCase('${r.id}')">Buka</button></td>
    </tr>`).join('')}
  </table>`;
}

async function updateStatusKlaim(id, newStatus){
  const { error } = await supabase.from('claims').update({status_klaim:newStatus}).eq('id', id);
  if(error){ alert('Gagal memperbarui status: ' + error.message); }
  renderArsip();
}

async function reopenCase(id){
  const { data: c, error } = await supabase.from('claims').select('*, ai_results!inner(*)').eq('id', id).eq('ai_results.is_current', true).single();
  if(error || !c){ alert('Gagal membuka kasus.'); return; }
  editingClaimId = id;
  document.getElementById('f_rm').value = c.no_rm||'';
  document.getElementById('f_nama').value = c.nama_pasien||'';
  document.getElementById('f_jenis').value = c.jenis_pelayanan;
  document.getElementById('f_dpjp').value = c.dpjp||'';
  document.getElementById('f_status_klaim').value = c.status_klaim;
  document.getElementById('f_kelas_bpjs').value = c.kelas_bpjs||'3';
  document.getElementById('f_usia').value = c.usia||'';
  document.getElementById('f_jk').value = c.jenis_kelamin||'';
  document.getElementById('f_tgl_masuk').value = c.tgl_masuk||'';
  document.getElementById('f_tgl_keluar').value = c.tgl_keluar||'';
  document.getElementById('f_readmisi').checked = c.readmisi;
  document.getElementById('f_tgl_pulang_prev').value = c.tgl_pulang_prev||'';
  document.getElementById('f_dx_prev').value = c.dx_prev||'';
  document.getElementById('f_dx_utama').value = c.dx_utama||'';
  document.getElementById('f_dx_sek').value = c.dx_sekunder||'';
  document.getElementById('f_tindakan').value = c.tindakan||'';
  document.getElementById('f_klinis').value = c.klinis||'';
  document.getElementById('f_soap_s').value = c.soap_s||'';
  document.getElementById('f_soap_o').value = c.soap_o||'';
  document.getElementById('f_soap_a').value = c.soap_a||'';
  document.getElementById('f_soap_p').value = c.soap_p||'';
  document.getElementById('f_lab').value = c.lab||'';
  document.getElementById('f_radiologi').value = c.radiologi||'';
  document.getElementById('f_penunjang_lain').value = c.penunjang_lain||'';
  document.getElementById('f_tarif_aktual').value = c.tarif_aktual||'';
  document.getElementById('f_tarif_riil').value = c.tarif_riil||'';
  tarifTerpilih = c.tarif_terpilih||null;
  checklistState = c.checklist_state||{};
  toggleKelasBpjs(); toggleReadmisiFields();

  const ai = c.ai_results[0];
  lastResult = {
    diagnosis_utama: ai.diagnosis_utama, diagnosis_sekunder: ai.diagnosis_sekunder, prosedur: ai.prosedur,
    severity_sebelum: ai.severity_sebelum, severity_sesudah: ai.severity_sesudah,
    estimasi_tarif_sebelum: ai.estimasi_tarif_sebelum, estimasi_tarif_sesudah: ai.estimasi_tarif_sesudah,
    temuan_potensi_kelengkapan: ai.temuan_potensi_kelengkapan, rekomendasi_konfirmasi_dpjp: ai.rekomendasi_konfirmasi_dpjp,
    red_flags_klinis: ai.red_flags_klinis, catatan_umum: ai.catatan_umum,
  };
  lastInput = readCaseInput();
  await primeCodeValidityCache(lastResult);
  renderResult(lastResult, {tarifAktual: c.tarif_aktual, tarifRiil: c.tarif_riil}, lastInput);
  updateChecklist();
  switchTab('analisa');
}

function csvEscape(v){ if(v===null||v===undefined) return ''; const s=String(v); return (s.includes(',')||s.includes('"')||s.includes('\n')) ? '"'+s.replace(/"/g,'""')+'"' : s; }
function downloadCsv(filename, rows, headers){
  const lines = [headers.join(','), ...rows.map(r => headers.map(h=>csvEscape(r[h])).join(','))];
  const blob = new Blob(['﻿'+lines.join('\n')], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function exportArsipCsv(){
  const rows = (window._allClaims||[]).map(r => ({
    no_rm: r.no_rm, nama_pasien: r.nama_pasien, dx_utama: r.dx_utama, dpjp: r.dpjp,
    severity: r.ai?.severity_sesudah, status: r.status_klaim, tarif_aktual: r.tarif_aktual,
  }));
  downloadCsv('arsip_pasien.csv', rows, ['no_rm','nama_pasien','dx_utama','dpjp','severity','status','tarif_aktual']);
}

// ---------------------------------------------------------------------
// SKRINING UPCODING — dibaca dari tabel screening_flags (dihitung server-side)
// ---------------------------------------------------------------------
const SCREENING_LABELS = {
  severityNoCC: 'Severity II/III tanpa CC/MCC jelas',
  losShortForSeverity: 'LOS lebih pendek dari perkiraan severity',
  highRiskDxNoEvidence: 'Diagnosis rawan-upcoding tanpa bukti penunjang',
  tooManySecondaryDx: 'Diagnosis sekunder terlalu banyak (>8)',
  surgicalNoProcedure: 'Ada tindakan tanpa kode prosedur',
  tariffOutlierStat: 'Tarif outlier statistik (kode CBG sama)',
  losOutlier: 'LOS outlier statistik (kode CBG sama)',
  tariffAboveOfficial: 'Tarif melebihi tarif resmi',
  readmission: 'Readmisi <5 hari',
  icd10FormatInvalid: 'Ada kode ICD-10 tidak dikenali',
  icd9CategoryUnknown: 'Ada kode ICD-9-CM tidak dikenali',
  severityCodeMismatch: 'Akhiran kode CBG tidak cocok severity',
  dpjpPattern: 'Pola skor DPJP di atas rata-rata (case-mix disesuaikan)',
};

async function fetchScreening(){
  const { data, error } = await supabase.from('screening_flags')
    .select('*, claims(no_rm, nama_pasien, dx_utama, dpjp, status_klaim)')
    .order('score', { ascending: false });
  if(error){ console.error(error); return []; }
  return data;
}

async function renderSkrining(){
  const kpiEl = document.getElementById('skriningKpis');
  const bodyEl = document.getElementById('skriningBody');
  const results = await fetchScreening();
  window._skriningResults = results;

  if(!results.length){
    kpiEl.innerHTML = '';
    bodyEl.innerHTML = '<div class="empty"><div class="glyph">◆</div><p>Belum ada klaim dengan hasil analisa untuk diskrining.</p></div>';
    return;
  }
  const nTinggi = results.filter(r=>r.level==='Tinggi').length;
  const nSedang = results.filter(r=>r.level==='Sedang').length;
  kpiEl.innerHTML = `
    <div class="kpi red"><div class="kl">Risiko Tinggi</div><div class="kv">${nTinggi}</div></div>
    <div class="kpi gold"><div class="kl">Risiko Sedang</div><div class="kv">${nSedang}</div></div>
    <div class="kpi"><div class="kl">Total Klaim Diskrining</div><div class="kv">${results.length}</div></div>
  `;

  const q = (document.getElementById('f_skrining_search').value||'').toLowerCase();
  const filterRisk = document.getElementById('f_skrining_risk').value;
  const filtered = results.filter(r => {
    if(filterRisk && r.level !== filterRisk) return false;
    if(!q) return true;
    const c = r.claims||{};
    return [c.no_rm, c.nama_pasien, c.dpjp, c.dx_utama].some(v => (v||'').toLowerCase().includes(q));
  });

  if(!filtered.length){ bodyEl.innerHTML = '<div class="empty"><p>Tidak ada klaim yang cocok filter.</p></div>'; return; }
  bodyEl.innerHTML = `<table class="skrining"><tr><th>No. RM</th><th>Pasien</th><th>DPJP</th><th>Skor</th><th>Tingkat</th><th>Jml. Flag</th></tr>
    ${filtered.map(r => { const c = r.claims||{}; return `<tr onclick="openSkriningDetail('${r.claim_id}')">
      <td>${esc(c.no_rm||'—')}</td><td>${esc(c.nama_pasien||'—')}</td><td>${esc(c.dpjp||'—')}</td>
      <td>${r.score}</td><td><span class="risk-pill ${r.level}">${r.level}</span></td><td>${(r.flags||[]).length}</td>
    </tr>`; }).join('')}
  </table>`;
}

async function openSkriningDetail(claimId){
  const row = (window._skriningResults||[]).find(r => r.claim_id === claimId);
  const panel = document.getElementById('skriningDetailPanel');
  if(!row){ panel.innerHTML=''; return; }
  const c = row.claims || {};
  panel.innerHTML = `
    <div class="skrining-modal-backdrop" onclick="if(event.target===this) this.remove()">
      <div class="skrining-modal">
        <h2 style="margin-top:0;">${esc(c.nama_pasien||c.no_rm||'Detail Klaim')}</h2>
        <p class="hint">${esc(c.dx_utama||'')} · DPJP: ${esc(c.dpjp||'—')} · Status: ${esc(c.status_klaim||'—')}</p>
        <div class="section-title">Flag Terdeteksi (skor total: ${row.score}, tingkat ${row.level})</div>
        ${(row.flags||[]).length ? (row.flags||[]).map(f => `<div class="flag-row"><span class="flag-weight">${esc(f)}</span><span>${esc(SCREENING_LABELS[f]||f)}</span></div>`).join('') : '<p class="hint">Tidak ada flag.</p>'}
        ${row.catatan_case_mix ? `<div class="case-mix-note">${esc(row.catatan_case_mix)}</div>` : ''}
        <div style="margin-top:16px;text-align:right;"><button class="ghost" onclick="this.closest('.skrining-modal-backdrop').remove()">Tutup</button></div>
      </div>
    </div>
  `;
}

function exportSkriningCsv(){
  const rows = (window._skriningResults||[]).filter(r=>r.level!=='Rendah').map(r => {
    const c = r.claims||{};
    return { no_rm: c.no_rm, nama_pasien: c.nama_pasien, dpjp: c.dpjp, skor: r.score, tingkat: r.level, flags: (r.flags||[]).join('; ') };
  });
  downloadCsv('skrining_upcoding.csv', rows, ['no_rm','nama_pasien','dpjp','skor','tingkat','flags']);
}

// ---------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------
async function renderDashboard(){
  const body = document.getElementById('dashBody');
  const rows = window._allClaims || await fetchAllClaimsWithResult();
  if(!rows.length){ body.innerHTML = '<div class="empty"><div class="glyph">Σ</div><p>Belum ada kasus tersimpan.</p></div>'; return; }

  const byStatus = {};
  rows.forEach(r => byStatus[r.status_klaim] = (byStatus[r.status_klaim]||0)+1);
  const totalUplift = rows.reduce((s,r) => {
    const before = tarifRange(r.ai?.estimasi_tarif_sebelum);
    const after = r.tarif_aktual || (tarifRange(r.ai?.estimasi_tarif_sesudah)||{}).mid;
    return s + ((before && after) ? (after - before.mid) : 0);
  }, 0);

  body.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><div class="kl">Total Kasus</div><div class="kv">${rows.length}</div></div>
      <div class="kpi teal"><div class="kl">Potensi Selisih Tarif Kumulatif</div><div class="kv">${fmtRp(totalUplift)}</div></div>
      <div class="kpi gold"><div class="kl">Diajukan ke BPJS</div><div class="kv">${byStatus['Diajukan ke BPJS']||0}</div></div>
    </div>
    <table class="dash"><tr><th>Status</th><th>Jumlah</th></tr>
      ${Object.entries(byStatus).map(([s,n]) => `<tr><td><span class="status-chip ${statusClass(s)}">${esc(s)}</span></td><td>${n}</td></tr>`).join('')}
    </table>
  `;
}

// ---------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', initAuth);
