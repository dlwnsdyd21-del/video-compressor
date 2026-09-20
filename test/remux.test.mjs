/*
 * remux.js 검증 테스트.
 *   실행:  node test/remux.test.mjs
 *
 * ffmpeg 로 "크롬 MediaRecorder 가 뱉는 모양"의 조각난 MP4 를 여러 개 만들어 두고,
 * remuxToProgressiveMp4() 를 돌린 뒤 ffprobe 로 결과를 검사한다.
 *   - 길이가 0/N/A 가 아니고 원본과 0.1초 이내로 일치하는가
 *   - 코덱·해상도·회전·패킷 수(영상 프레임 수, 오디오 프레임 수)가 원본과 같은가
 *   - 출력에 moof/mvex 가 없고 (조각나지 않았고) moov 가 mdat 앞에 있는가
 *   - 두 스트림의 첫/마지막 PTS 가 서로 어긋나지 않는가 (A/V 싱크)
 *   - ffmpeg 로 전체 디코딩했을 때 에러가 한 줄도 없는가
 *
 * 픽스처는 test/fixtures/ 에 만든다 (.gitignore 에 이미 들어 있음).
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIX = path.join(HERE, 'fixtures');

/* ── remux.js 불러오기 ───────────────────────────────────────────────
   프로젝트에 package.json 이 없어서 Node 는 .js 를 CommonJS 로 본다.
   (브라우저에서는 <script type="module"> 이라 문제가 없다.)
   그래서 테스트에서는 .mjs 복사본을 만들어 ESM 으로 불러온다. */
fs.mkdirSync(FIX, { recursive: true });
const SRC = path.join(ROOT, 'remux.js');
const COPY = path.join(FIX, '_remux.under-test.mjs');
fs.writeFileSync(COPY, fs.readFileSync(SRC));
const { remuxToProgressiveMp4, isFragmentedMp4 } = await import(pathToFileURL(COPY).href + '?t=' + Date.now());

/* ── 작은 도우미들 ────────────────────────────────────────────────── */

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** ffmpeg 은 로그를 stderr 로 보낸다. 성공/실패와 stderr 를 같이 돌려준다. */
async function runCapture(cmd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || String(e) };
  }
}

/** 백신이 갓 만들어진 미디어 파일을 잠깐 잠그는 일이 있어 짧게 재시도한다 */
function writeFileRetry(p, data, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { fs.writeFileSync(p, data); return; }
    catch (e) { if (i === tries - 1) throw e; sleep(150); }
  }
}
function readFileRetry(p, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { return fs.readFileSync(p); }
    catch (e) { if (i === tries - 1) throw e; sleep(150); }
  }
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** ffprobe JSON */
function probe(file, extra = []) {
  const out = run('ffprobe', [
    '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', ...extra, file,
  ]);
  return JSON.parse(out);
}

/** 스트림별 패킷 수 (조각난 파일도 전수 스캔하므로 정확하다) */
function packetCount(file, selector) {
  const out = run('ffprobe', [
    '-v', 'error', '-select_streams', selector, '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-print_format', 'json', file,
  ]);
  const s = JSON.parse(out).streams;
  return s && s.length ? Number(s[0].nb_read_packets) : null;
}

/** 패킷 PTS 전체(초). 디코딩 순서 그대로 돌려준다. */
function ptsList(file, selector) {
  const out = run('ffprobe', [
    '-v', 'error', '-select_streams', selector, '-show_entries', 'packet=pts_time',
    '-print_format', 'json', file,
  ]);
  return (JSON.parse(out).packets || [])
    .map(p => Number(p.pts_time)).filter(n => Number.isFinite(n));
}

/** 첫/마지막 패킷의 PTS(초) */
function ptsRange(file, selector) {
  const pkts = ptsList(file, selector).slice().sort((a, b) => a - b);
  if (!pkts.length) return null;
  return { first: pkts[0], last: pkts[pkts.length - 1] };
}

/**
 * 두 파일의 PTS "모양"이 같은지 — 각자의 첫 PTS 를 뺀 상대 시각이 일치해야 한다.
 * (B프레임 재정렬 순서까지 그대로 보존됐는지 확인한다)
 */
function ptsShapeMatches(aFile, bFile, selector, tol = 0.002) {
  const a = ptsList(aFile, selector);
  const b = ptsList(bFile, selector);
  if (a.length !== b.length || !a.length) return { ok: false, detail: `패킷 수 ${a.length} vs ${b.length}` };
  const a0 = a[0], b0 = b[0];
  let worst = 0, at = -1;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs((a[i] - a0) - (b[i] - b0));
    if (d > worst) { worst = d; at = i; }
  }
  return { ok: worst <= tol, detail: `최대 오차 ${worst.toFixed(6)}s (패킷 #${at})` };
}

/** 회전각 (display matrix). 없으면 0. */
function rotationOf(file) {
  const out = run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-print_format', 'json',
    '-show_streams', file,
  ]);
  const st = (JSON.parse(out).streams || [])[0];
  if (!st) return 0;
  const sd = (st.side_data_list || []).find(d => d.rotation !== undefined);
  if (sd) return ((Number(sd.rotation) % 360) + 360) % 360;
  if (st.tags && st.tags.rotate) return ((Number(st.tags.rotate) % 360) + 360) % 360;
  return 0;
}

/** [start,end) 의 형제 박스들을 직접 훑는다 (ffprobe 를 믿지 않고 바이트로 확인) */
function scanBoxes(buf, start = 0, end = buf.length) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o);
    let hdr = 8;
    const type = buf.toString('latin1', o + 4, o + 8);
    if (size === 1) { size = Number(buf.readBigUInt64BE(o + 8)); hdr = 16; }
    else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) break;
    out.push({ type, start: o, size, body: o + hdr, end: o + size });
    o += size;
  }
  return out;
}
const topLevelBoxes = buf => scanBoxes(buf);
const kid = (buf, b, type) => scanBoxes(buf, b.body, b.end).find(x => x.type === type);

/** 버퍼 어딘가에 해당 4CC 가 박스 헤더로 등장하는지 (mvex 등 중첩 박스 확인용) */
function containsBoxType(buf, type) {
  const needle = Buffer.from(type, 'latin1');
  let i = buf.indexOf(needle, 0);
  while (i >= 4) {
    // 바로 앞 4바이트가 그럴듯한 박스 크기면 진짜 박스로 본다
    const size = buf.readUInt32BE(i - 4);
    if (size >= 8 && i - 4 + size <= buf.length) return true;
    i = buf.indexOf(needle, i + 1);
  }
  return false;
}

/* ── 픽스처 생성 ─────────────────────────────────────────────────── */

// 크롬 MediaRecorder 와 같은 모양: empty_moov + moof/mdat, sidx/mfra 없음
const FRAG_FLAGS = 'frag_keyframe+empty_moov+default_base_moof+skip_sidx+skip_trailer';

function buildFixture(name, args, rotate) {
  const out = path.join(FIX, name + '.mp4');
  if (fs.existsSync(out)) fs.rmSync(out, { force: true });
  if (!rotate) {
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, '-y', out]);
    return out;
  }
  /* 회전 픽스처는 두 단계로 만든다.
     lavfi 입력에 -display_rotation 을 붙여도 행렬이 따라오지 않으므로,
     먼저 평범한 파일을 만든 뒤 -c copy 로 다시 담으면서 회전을 입힌다. */
  const base = path.join(FIX, name + '.base.mp4');
  if (fs.existsSync(base)) fs.rmSync(base, { force: true });
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, '-y', base]);
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-display_rotation:v', String(rotate), '-i', base, '-c', 'copy',
    '-movflags', FRAG_FLAGS, '-y', out]);
  return out;
}

function src(size, rate, dur) {
  return ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${dur}`];
}
function sine(dur) {
  return ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${dur}`];
}

const FIXTURES = [
  {
    name: '480x854_5s_av',
    why: '유저 파일과 같은 9:16 세로, 영상+오디오 5초',
    args: [...src('480x854', 30, 5), ...sine(5),
      '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.1', '-pix_fmt', 'yuv420p', '-bf', '0',
      '-c:a', 'aac', '-b:a', '64k', '-ac', '2',
      '-movflags', FRAG_FLAGS],
  },
  {
    name: '640x360_3s_videoonly',
    why: '오디오 없는 영상 전용 트랙',
    args: [...src('640x360', 25, 3),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '0', '-an',
      '-movflags', FRAG_FLAGS],
  },
  {
    name: '640x360_8s_bframes',
    why: 'B프레임(-bf 2) → ctts/stss 가 필요한 경우',
    args: [...src('640x360', 30, 8), ...sine(8),
      '-c:v', 'libx264', '-profile:v', 'high', '-bf', '2', '-g', '60', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
      '-movflags', FRAG_FLAGS],
  },
  {
    name: '480x854_6s_rot90',
    why: '회전(display matrix 90도) 보존 확인 — 세로로 찍은 갤럭시 영상과 같은 상황',
    rotate: 90,
    expectRotation: 90,
    args: [...src('480x854', 30, 6), ...sine(6),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '0',
      '-c:a', 'aac', '-b:a', '64k', '-ac', '2',
      '-movflags', '+faststart'],
  },
  {
    name: '480x854_4s_rot270',
    why: '회전 270도 (반대 방향) 보존 확인',
    rotate: 270,
    expectRotation: 270,
    args: [...src('480x854', 30, 4),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '0', '-an',
      '-movflags', '+faststart'],
  },
  {
    name: '720x1280_30s_long',
    why: '길이가 길어 청크/교차배치(interleave)가 많이 생기는 경우',
    args: [...src('720x1280', 30, 30), ...sine(30),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-bf', '0', '-g', '90',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-movflags', FRAG_FLAGS],
  },
  {
    name: '640x360_5s_tinyfrags',
    why: '0.2초마다 조각이 나는 극단적인 경우 (조각 수가 많음)',
    args: [...src('640x360', 30, 5), ...sine(5),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '0', '-g', '6',
      '-c:a', 'aac', '-b:a', '64k', '-ac', '2',
      '-movflags', FRAG_FLAGS, '-frag_duration', '200000'],
  },
  {
    name: '640x360_4s_mono48k',
    why: '모노 48kHz 오디오 (타임스케일이 영상과 크게 다른 경우)',
    args: [...src('640x360', 24, 4),
      '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '0',
      '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
      '-movflags', FRAG_FLAGS],
  },
];

/* ── 검증 ────────────────────────────────────────────────────────── */

const results = [];
let failures = 0;

function check(caseName, label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  results.push({ caseName, label, ok, detail: detail || '' });
  return ok;
}

async function verifyCase(fx) {
  const name = fx.name;
  let srcPath;
  try {
    srcPath = buildFixture(name, fx.args, fx.rotate);
  } catch (e) {
    check(name, '픽스처 생성', false, String(e.stderr || e.message).slice(0, 300));
    return;
  }

  const srcBuf = readFileRetry(srcPath);

  // 입력이 진짜로 조각나 있는지 먼저 확인 (아니면 테스트 자체가 무의미하다)
  const srcBoxes = topLevelBoxes(srcBuf);
  const srcHasMoof = srcBoxes.some(b => b.type === 'moof');
  if (!check(name, '입력이 조각난 MP4 (moof 존재)', srcHasMoof, srcBoxes.map(b => b.type).join(' '))) return;
  check(name, 'isFragmentedMp4() 가 true', isFragmentedMp4(srcBuf));

  const srcInfo = probe(srcPath);
  const srcV = srcInfo.streams.find(s => s.codec_type === 'video');
  const srcA = srcInfo.streams.find(s => s.codec_type === 'audio');
  const srcDur = Number(srcInfo.format.duration);
  const srcVPkts = srcV ? packetCount(srcPath, 'v:0') : null;
  const srcAPkts = srcA ? packetCount(srcPath, 'a:0') : null;
  const srcRot = srcV ? rotationOf(srcPath) : 0;
  // 회전 케이스는 원본에 실제로 회전이 붙어 있어야 의미가 있다 (검사가 헛돌지 않도록)
  if (fx.expectRotation !== undefined) {
    check(name, `원본에 회전 ${fx.expectRotation}도가 실제로 들어 있음`,
      srcRot === fx.expectRotation, `원본 회전=${srcRot}도`);
  }

  // ── 변환 ──
  let outBytes, ms, heapMB;
  try {
    const view = new Uint8Array(srcBuf.buffer, srcBuf.byteOffset, srcBuf.byteLength);
    if (global.gc) global.gc();
    const m0 = process.memoryUsage();
    const t0 = process.hrtime.bigint();
    outBytes = remuxToProgressiveMp4(view);
    ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const m1 = process.memoryUsage();
    heapMB = (m1.heapUsed - m0.heapUsed + m1.external - m0.external) / 1048576;
  } catch (e) {
    check(name, 'remuxToProgressiveMp4() 실행', false, e.message);
    return;
  }
  const srcMB = srcBuf.length / 1048576;
  check(name, 'remuxToProgressiveMp4() 실행', true,
    `${srcMB.toFixed(2)}MB → ${(outBytes.length / 1048576).toFixed(2)}MB, ${ms.toFixed(1)}ms, 추가메모리 ~${heapMB.toFixed(1)}MB`);
  // 크기가 비슷해야 한다 — 재인코딩이 아니라 컨테이너만 바꾼 것이므로
  check(name, '출력 크기가 입력의 ±3% 이내 (재포장만 함)',
    Math.abs(outBytes.length - srcBuf.length) / srcBuf.length <= 0.03,
    `${srcBuf.length} → ${outBytes.length}`);
  // 휴대폰에서도 체감되지 않을 속도여야 한다 (데스크톱 기준 여유 있게)
  check(name, '변환 시간이 입력 1MB당 100ms 이내', ms <= Math.max(200, srcMB * 100),
    `${ms.toFixed(1)}ms / ${srcMB.toFixed(2)}MB`);

  const outPath = path.join(FIX, name + '.out.mp4');
  const outBuf = Buffer.from(outBytes.buffer, outBytes.byteOffset, outBytes.byteLength);
  writeFileRetry(outPath, outBuf);

  // ── 구조 검사 (바이트 직접 확인) ──
  const boxes = topLevelBoxes(outBuf);
  const types = boxes.map(b => b.type);
  check(name, '출력에 moof 가 없음 (조각나지 않음)', !types.includes('moof'), types.join(' '));
  check(name, '출력에 mfra/sidx 가 없음', !types.includes('mfra') && !types.includes('sidx'), types.join(' '));
  const iFtyp = types.indexOf('ftyp'), iMoov = types.indexOf('moov'), iMdat = types.indexOf('mdat');
  check(name, 'ftyp → moov → mdat 순서 (faststart)',
    iFtyp === 0 && iMoov > iFtyp && iMdat > iMoov, types.join(' '));
  const moovBox = boxes.find(b => b.type === 'moov');
  const moovBuf = outBuf.subarray(moovBox.start, moovBox.start + moovBox.size);
  check(name, 'moov 안에 mvex 가 없음', !containsBoxType(moovBuf, 'mvex'));
  check(name, 'moov 안에 stts/stsz/stsc 가 들어 있음',
    containsBoxType(moovBuf, 'stts') && containsBoxType(moovBuf, 'stsz') && containsBoxType(moovBuf, 'stsc'));
  const ftypBrands = outBuf.toString('latin1', 8, 12) + ' | ' + outBuf.toString('latin1', 16, boxes[0].size);
  check(name, 'ftyp 호환 브랜드에 isom/mp41 포함',
    ftypBrands.includes('isom') && ftypBrands.includes('mp41'), ftypBrands);

  // ── ffprobe 검사 ──
  let outInfo;
  try { outInfo = probe(outPath); }
  catch (e) { check(name, 'ffprobe 로 출력 읽기', false, String(e.stderr || e.message).slice(0, 300)); return; }
  check(name, 'ffprobe 로 출력 읽기', true);

  const outDur = Number(outInfo.format.duration);
  check(name, '길이가 0/N/A 가 아님', Number.isFinite(outDur) && outDur > 0, `duration=${outInfo.format.duration}`);
  check(name, `길이가 원본과 0.1초 이내 일치`, Math.abs(outDur - srcDur) <= 0.1,
    `src=${srcDur.toFixed(3)}s out=${outDur.toFixed(3)}s`);

  // 헤더만 읽는 소비자(안드로이드 MediaStore) 관점: moov 만 잘라내도 길이가 나와야 한다
  const moovOnly = path.join(FIX, name + '.moovonly.mp4');
  writeFileRetry(moovOnly, outBuf.subarray(0, moovBox.start + moovBox.size));
  try {
    const mo = probe(moovOnly);
    const moDur = Number(mo.format.duration);
    check(name, 'moov 만으로도 길이를 알 수 있음 (헤더만 읽는 앱 대비)',
      Number.isFinite(moDur) && Math.abs(moDur - srcDur) <= 0.15, `moov-only duration=${mo.format.duration}`);
  } catch (e) {
    check(name, 'moov 만으로도 길이를 알 수 있음 (헤더만 읽는 앱 대비)', false, 'ffprobe 실패');
  }

  const outV = outInfo.streams.find(s => s.codec_type === 'video');
  const outA = outInfo.streams.find(s => s.codec_type === 'audio');

  if (srcV) {
    check(name, '영상 코덱 동일', outV && outV.codec_name === srcV.codec_name,
      `${srcV.codec_name} → ${outV && outV.codec_name}`);
    check(name, '해상도 동일', outV && outV.width === srcV.width && outV.height === srcV.height,
      `${srcV.width}x${srcV.height} → ${outV && outV.width}x${outV.height}`);
    check(name, '픽셀 포맷/프로파일 동일',
      outV && outV.profile === srcV.profile && outV.pix_fmt === srcV.pix_fmt,
      `${srcV.profile}/${srcV.pix_fmt} → ${outV && outV.profile}/${outV && outV.pix_fmt}`);
    const outVPkts = packetCount(outPath, 'v:0');
    check(name, '영상 프레임(패킷) 수 동일', outVPkts === srcVPkts, `${srcVPkts} → ${outVPkts}`);
    check(name, '회전 정보(display matrix) 보존', rotationOf(outPath) === srcRot,
      `${srcRot}도 → ${rotationOf(outPath)}도`);
    // 조각난 원본은 nb_frames 가 N/A 다. 출력은 표가 있으니 숫자가 나와야 한다.
    check(name, 'nb_frames 가 헤더에서 바로 읽힘 (원본은 N/A)',
      outV && outV.nb_frames !== undefined && Number(outV.nb_frames) === srcVPkts,
      `src nb_frames=${srcV.nb_frames ?? 'N/A'} → out nb_frames=${outV && outV.nb_frames}`);
  } else {
    check(name, '오디오 없는 입력에 영상 트랙만 존재', !!outV && !outA);
  }

  if (srcA) {
    check(name, '오디오 코덱 동일', outA && outA.codec_name === srcA.codec_name,
      `${srcA.codec_name} → ${outA && outA.codec_name}`);
    check(name, '샘플레이트/채널 동일',
      outA && outA.sample_rate === srcA.sample_rate && outA.channels === srcA.channels,
      `${srcA.sample_rate}Hz ${srcA.channels}ch → ${outA && outA.sample_rate}Hz ${outA && outA.channels}ch`);
    const outAPkts = packetCount(outPath, 'a:0');
    check(name, '오디오 프레임(패킷) 수 동일', outAPkts === srcAPkts, `${srcAPkts} → ${outAPkts}`);
  } else {
    check(name, '오디오 트랙이 없어야 함', !outA);
  }

  // ── A/V 싱크 ──
  const vr = srcV ? ptsRange(outPath, 'v:0') : null;
  const ar = srcA ? ptsRange(outPath, 'a:0') : null;
  const srcVr = srcV ? ptsRange(srcPath, 'v:0') : null;
  if (vr) {
    // B프레임이 있으면 원본은 재정렬 지연 때문에 영상이 한두 프레임 늦게 시작한다.
    // 출력은 그보다 늦어져서는 안 되고, 2프레임(약 67ms) 안에는 들어와야 한다.
    check(name, '영상 첫 PTS 가 원본보다 늦지 않음', vr.first <= srcVr.first + 1e-6,
      `src=${srcVr.first} out=${vr.first}`);
    check(name, '영상 첫 PTS 가 0.067초 이내', vr.first >= 0 && vr.first <= 0.067, `first=${vr.first}`);
  }
  if (ar) check(name, '오디오 첫 PTS 가 0', Math.abs(ar.first) <= 1e-6, `first=${ar.first}`);
  // ctts 는 낡은 파서도 읽을 수 있는 version 0 (음수 오프셋 없음) 이어야 한다
  const cttsAt = moovBuf.indexOf(Buffer.from('ctts', 'latin1'));
  if (cttsAt > 0) {
    check(name, 'ctts 가 version 0 (음수 오프셋 없음)', moovBuf[cttsAt + 4] === 0,
      `version=${moovBuf[cttsAt + 4]}`);
  }
  if (vr && ar) {
    check(name, '첫 PTS 가 두 스트림 간 0.1초 이내', Math.abs(vr.first - ar.first) <= 0.1,
      `v=${vr.first} a=${ar.first}`);
    check(name, '마지막 PTS 가 두 스트림 간 0.2초 이내', Math.abs(vr.last - ar.last) <= 0.2,
      `v=${vr.last} a=${ar.last}`);
  }
  if (vr) check(name, '마지막 영상 PTS 가 길이와 맞음', Math.abs(vr.last - srcDur) <= 0.2,
    `last=${vr.last} dur=${srcDur.toFixed(3)}`);

  // 프레임 타이밍이 원본과 똑같은 모양인지 (재정렬·간격 보존)
  if (srcV) {
    const shape = ptsShapeMatches(srcPath, outPath, 'v:0');
    check(name, '영상 PTS 간격/순서가 원본과 동일', shape.ok, shape.detail);
  }
  if (srcA) {
    const shape = ptsShapeMatches(srcPath, outPath, 'a:0');
    check(name, '오디오 PTS 간격/순서가 원본과 동일', shape.ok, shape.detail);
  }

  // ── 전체 디코딩: 에러 한 줄도 없어야 한다 ──
  const dec = await runCapture('ffmpeg', ['-v', 'error', '-i', outPath, '-f', 'null', '-']);
  check(name, 'ffmpeg 전체 디코딩 시 에러 없음', dec.ok && dec.stderr.trim() === '',
    dec.stderr.trim().slice(0, 300) || 'clean');

  // ── 원본과 스트림 바이트가 완전히 같은지 (재인코딩이 아님을 증명) ──
  const md5src = streamMd5(srcPath);
  const md5out = streamMd5(outPath);
  check(name, '영상 스트림 바이트 동일 (재인코딩 아님)', md5src.v && md5src.v === md5out.v,
    `${md5src.v} vs ${md5out.v}`);
  if (srcA) check(name, '오디오 스트림 바이트 동일', md5src.a && md5src.a === md5out.a,
    `${md5src.a} vs ${md5out.a}`);
}

/** 디코딩된 스트림의 MD5 — 컨테이너만 바뀌었다면 똑같이 나와야 한다 */
function streamMd5(file) {
  const res = { v: null, a: null };
  try {
    res.v = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
      '-map', '0:v:0', '-c', 'copy', '-f', 'md5', '-']).trim();
  } catch { /* 영상 트랙이 없을 수 있다 */ }
  try {
    res.a = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
      '-map', '0:a:0', '-c', 'copy', '-f', 'md5', '-']).trim();
  } catch { /* 오디오 트랙이 없을 수 있다 */ }
  return res;
}

/** 이미 progressive 인 파일은 손대지 않고 그대로 돌려줘야 한다 */
function verifyPassthrough() {
  const name = 'passthrough_progressive';
  const p = buildFixture(name, [...src('320x240', 25, 2), ...sine(2),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '0', '-c:a', 'aac', '-b:a', '64k',
    '-movflags', '+faststart']);
  const buf = readFileRetry(p);
  check(name, '입력이 조각나지 않음', !topLevelBoxes(buf).some(b => b.type === 'moof'));
  const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = remuxToProgressiveMp4(view);
  check(name, '이미 progressive 면 그대로 반환 (길이 동일)', out.length === view.length,
    `${view.length} → ${out.length}`);
  check(name, '이미 progressive 면 그대로 반환 (바이트 동일)',
    Buffer.compare(Buffer.from(out.buffer, out.byteOffset, out.byteLength), buf) === 0);
}

/**
 * 한 트랙이 늦게 시작하는 경우 — edts/elst 로 싱크를 맞추는지 확인한다.
 *
 * ffmpeg 은 mp4 로 쓸 때 각 트랙의 첫 DTS 를 0 으로 정규화해 버려서
 * "오디오만 0.5초 늦게 시작하는" 조각 파일을 못 만든다.
 * 그래서 정상 파일을 만든 뒤 오디오 traf 의 tfdt 값만 직접 밀어 넣는다.
 * (크롬 MediaRecorder 는 영상·오디오 캡처 시작 시점이 달라 실제로 이런 파일을 만든다)
 */
function verifyLateStartTrack() {
  const name = 'late_start_audio';
  const base = buildFixture(name + '_base', [...src('640x360', 30, 5), ...sine(5),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '0',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-movflags', FRAG_FLAGS]);
  const buf = readFileRetry(base);

  // moov 에서 오디오 트랙 id 와 타임스케일을 찾는다
  const top = topLevelBoxes(buf);
  const moov = top.find(b => b.type === 'moov');
  let audioId = -1, audioTs = 0;
  for (const trak of scanBoxes(buf, moov.body, moov.end).filter(b => b.type === 'trak')) {
    const mdia = kid(buf, trak, 'mdia');
    const hdlr = kid(buf, mdia, 'hdlr');
    if (buf.toString('latin1', hdlr.body + 8, hdlr.body + 12) !== 'soun') continue;
    const tkhd = kid(buf, trak, 'tkhd');
    audioId = buf[tkhd.body] === 1 ? buf.readUInt32BE(tkhd.body + 20) : buf.readUInt32BE(tkhd.body + 12);
    const mdhd = kid(buf, mdia, 'mdhd');
    audioTs = buf[mdhd.body] === 1 ? buf.readUInt32BE(mdhd.body + 20) : buf.readUInt32BE(mdhd.body + 12);
  }
  if (!check(name, '오디오 트랙을 찾음', audioId > 0 && audioTs > 0, `id=${audioId} ts=${audioTs}`)) return;

  // 오디오 traf 의 tfdt 를 0.5초만큼 민다
  const SHIFT_SEC = 0.5;
  const shift = Math.round(SHIFT_SEC * audioTs);
  let patched = 0;
  for (const moof of top.filter(b => b.type === 'moof')) {
    for (const traf of scanBoxes(buf, moof.body, moof.end).filter(b => b.type === 'traf')) {
      const tfhd = kid(buf, traf, 'tfhd');
      if (!tfhd || buf.readUInt32BE(tfhd.body + 4) !== audioId) continue;
      const tfdt = kid(buf, traf, 'tfdt');
      if (!tfdt) continue;
      if (buf[tfdt.body] === 1) buf.writeBigUInt64BE(buf.readBigUInt64BE(tfdt.body + 4) + BigInt(shift), tfdt.body + 4);
      else buf.writeUInt32BE(buf.readUInt32BE(tfdt.body + 4) + shift, tfdt.body + 4);
      patched++;
    }
  }
  if (!check(name, `오디오 tfdt 를 ${SHIFT_SEC}초 밀었음`, patched > 0, `${patched}개 traf`)) return;

  const srcPath = path.join(FIX, name + '.mp4');
  writeFileRetry(srcPath, buf);
  const srcAStart = ptsRange(srcPath, 'a:0').first;
  check(name, '원본 오디오가 실제로 0.5초 늦게 시작함', Math.abs(srcAStart - SHIFT_SEC) <= 0.02,
    `오디오 첫 PTS=${srcAStart}`);

  const out = remuxToProgressiveMp4(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  const outBuf = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  const outPath = path.join(FIX, name + '.out.mp4');
  writeFileRetry(outPath, outBuf);

  // 늦게 시작하는 트랙에는 edts/elst 가 붙어야 한다
  const oTop = topLevelBoxes(outBuf);
  const oMoov = oTop.find(b => b.type === 'moov');
  let edtsCount = 0;
  for (const trak of scanBoxes(outBuf, oMoov.body, oMoov.end).filter(b => b.type === 'trak')) {
    if (kid(outBuf, trak, 'edts')) edtsCount++;
  }
  check(name, '늦게 시작하는 트랙에 edts/elst 가 생김', edtsCount === 1, `edts ${edtsCount}개`);

  const outAStart = ptsRange(outPath, 'a:0').first;
  const outVStart = ptsRange(outPath, 'v:0').first;
  check(name, '출력에서도 오디오가 0.5초 뒤에 시작 (싱크 유지)',
    Math.abs(outAStart - SHIFT_SEC) <= 0.05, `오디오 첫 PTS=${outAStart}`);
  check(name, '영상은 0에서 시작', Math.abs(outVStart) <= 0.02, `영상 첫 PTS=${outVStart}`);

  const info = JSON.parse(run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', outPath]));
  check(name, '길이가 0/N/A 가 아님', Number(info.format.duration) > 5.0, `duration=${info.format.duration}`);
  const shape = ptsShapeMatches(srcPath, outPath, 'a:0');
  check(name, '오디오 PTS 간격이 원본과 동일', shape.ok, shape.detail);
  const md5s = streamMd5(srcPath), md5o = streamMd5(outPath);
  check(name, '두 스트림 바이트 모두 동일', md5s.v === md5o.v && md5s.a === md5o.a);
}

/** 깨진 입력은 조용히 넘어가지 말고 분명한 에러를 던져야 한다 */
function verifyErrors() {
  const name = 'error_handling';
  const cases = [
    ['빈 입력', new Uint8Array(0)],
    ['MP4 가 아닌 바이트', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])],
    ['moov 없는 MP4', (() => {
      const b = new Uint8Array(24);
      new DataView(b.buffer).setUint32(0, 16);
      b.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
      b.set([0x69, 0x73, 0x6f, 0x6d], 8); // 'isom'
      new DataView(b.buffer).setUint32(16, 8);
      b.set([0x66, 0x72, 0x65, 0x65], 20); // 'free'
      return b;
    })()],
  ];
  for (const [label, bytes] of cases) {
    let threw = false, msg = '';
    try { remuxToProgressiveMp4(bytes); } catch (e) { threw = e instanceof Error; msg = e.message; }
    check(name, `${label} → Error 를 던짐`, threw, msg);
  }
}

/* ── 실행 ────────────────────────────────────────────────────────── */

console.log('remux.js 테스트 시작');
console.log('  대상 :', SRC);
console.log('  픽스처:', FIX);
console.log('  ffmpeg:', run('ffmpeg', ['-version']).split('\n')[0]);
console.log('');

for (const fx of FIXTURES) {
  process.stdout.write(`■ ${fx.name} — ${fx.why}\n`);
  const before = results.length;
  await verifyCase(fx);
  for (const r of results.slice(before)) {
    console.log(`    ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`);
  }
  console.log('');
}

process.stdout.write('■ passthrough_progressive — 이미 progressive 인 파일은 그대로\n');
let before = results.length;
verifyPassthrough();
for (const r of results.slice(before)) console.log(`    ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`);
console.log('');

process.stdout.write('■ late_start_audio — 오디오가 늦게 시작하면 edts/elst 로 싱크 보정\n');
before = results.length;
verifyLateStartTrack();
for (const r of results.slice(before)) console.log(`    ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`);
console.log('');

process.stdout.write('■ error_handling — 깨진 입력은 분명한 에러\n');
before = results.length;
verifyErrors();
for (const r of results.slice(before)) console.log(`    ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`);
console.log('');

/* ── 요약 ── */
const total = results.length;
const passed = results.filter(r => r.ok).length;
console.log('─'.repeat(72));
if (failures === 0) {
  console.log(`PASS — ${passed}/${total} 검사 통과 (케이스 ${FIXTURES.length + 3}개)`);
} else {
  console.log(`FAIL — ${total - passed}/${total} 검사 실패`);
  for (const r of results.filter(x => !x.ok)) {
    console.log(`  · [${r.caseName}] ${r.label}${r.detail ? '   → ' + r.detail : ''}`);
  }
}
console.log('─'.repeat(72));
process.exit(failures === 0 ? 0 : 1);
