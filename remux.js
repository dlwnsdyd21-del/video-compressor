/*
 * remux.js — 조각난(fragmented) MP4 를 일반(progressive) MP4 로 다시 포장한다.
 *
 * 왜 필요한가
 * -----------
 * 크롬의 MediaRecorder 가 'video/mp4' 로 녹화하면 결과물은 fMP4 다.
 *   ftyp | moov(mvex+trex, 샘플 표가 텅 빔) | moof | mdat | moof | mdat | ... | mfra
 * moov 안의 stts/stsz/stsc/stco 가 모두 0 개이고 mvhd/tkhd/mdhd 의 duration 도 0 이라
 * 파일 전체를 훑지 않는 소비자(안드로이드 MediaStore 색인기, 삼성 갤러리,
 * 카카오톡의 전송 전 검사)는 "길이 0 짜리 이상한 파일" 로 보고 거부한다.
 * 크롬 <video> 나 ffmpeg 는 moof 를 전부 스캔하므로 잘 재생된다 — 그래서
 * "미리보기는 되는데 공유/갤러리 저장은 안 되는" 증상이 나온다.
 *
 * 이 모듈은 재인코딩 없이 컨테이너만 다시 쓴다.
 *   1) moof/traf/trun 을 전부 걸어가며 샘플 목록(위치·크기·길이·CTS·키프레임)을 수집
 *   2) 진짜 stts/stsz/stsc/stco(또는 co64)/stss/ctts 를 만들고 duration 을 채운 moov 재구성
 *   3) ftyp | moov | mdat 순서(faststart)로 새로 쓴다. mvex 는 제거한다.
 * 픽셀/오디오 바이트는 그대로 복사되므로 화질 손실이 0 이고, 20MB 기준 수십 ms 면 끝난다.
 *
 * 메모리 사용량
 * -------------
 * 입력 버퍼는 복사하지 않고 subarray 로만 참조한다(뷰 생성뿐, 0 바이트 추가).
 * 추가로 잡는 큰 메모리는 딱 하나, 출력 Uint8Array(입력과 거의 같은 크기)다.
 * moof/mfra 오버헤드가 빠지고 샘플 표가 들어가므로 출력은 보통 입력의 ±0.5% 다.
 * 샘플 메타데이터는 샘플당 객체 하나(≈ 80B)라 30fps·90초(약 2700+4200 샘플)면 1MB 미만.
 * 즉 20MB 입력의 순간 최대 사용량은 "입력 20MB + 출력 20MB + 메타 1MB" 정도다.
 * 중간 표를 만들 때 자바스크립트 배열 spread 를 쓰지 않으므로(대신 DataView 로
 * 미리 잡은 Uint8Array 에 직접 씀) 샘플이 수십만 개여도 스택이 터지지 않는다.
 *
 * 사용법
 *   import { remuxToProgressiveMp4 } from './remux.js';
 *   const fixed = remuxToProgressiveMp4(await blob.arrayBuffer());
 *   const outBlob = new Blob([fixed], { type: 'video/mp4' });
 */

/* ────────────────────────── 바이트 쓰기 도우미 ────────────────────────── */

/** 'moov' 같은 4글자 타입을 바이트 4개로 */
function typeBytes(type) {
  return [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
}

/** 여러 Uint8Array 를 감싸 컨테이너 박스 하나로 만든다 */
function containerBox(type, parts) {
  let bodyLen = 0;
  for (const p of parts) bodyLen += p.length;
  const out = new Uint8Array(8 + bodyLen);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(typeBytes(type), 4);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * FullBox 하나를 한 번의 할당으로 만든다.
 * fill(dv, base) 이 base 부터 bodyLen 바이트를 직접 채운다 — 중간 배열을 만들지 않는다.
 */
function fullBox(type, version, flags, bodyLen, fill) {
  const out = new Uint8Array(12 + bodyLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length);
  out.set(typeBytes(type), 4);
  out[8] = version & 0xff;
  out[9] = (flags >>> 16) & 0xff;
  out[10] = (flags >>> 8) & 0xff;
  out[11] = flags & 0xff;
  if (fill) fill(dv, 12, out);
  return out;
}

/* ────────────────────────── 박스 파싱 ────────────────────────── */

/**
 * [start, end) 구간의 형제 박스들을 훑는다.
 * 반환: { type, start, end, body } — body 는 헤더 뒤(8 또는 16바이트 뒤) 위치.
 */
function scanBoxes(dv, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    let hdr = 8;
    const type = String.fromCharCode(dv.getUint8(o + 4), dv.getUint8(o + 5), dv.getUint8(o + 6), dv.getUint8(o + 7));
    if (size === 1) {
      if (o + 16 > end) break;
      size = Number(dv.getBigUint64(o + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - o; // 마지막 박스: 끝까지
    }
    if (size < hdr || o + size > end) break; // 잘린 파일 — 여기까지만 신뢰
    out.push({ type, start: o, end: o + size, body: o + hdr });
    o += size;
  }
  return out;
}

const findBox = (list, type) => list.find(b => b.type === type);

/* ────────────────────────── 메인 ────────────────────────── */

/**
 * 조각난 MP4 를 progressive MP4 로 변환한다.
 *
 * @param {ArrayBuffer|Uint8Array} input  MediaRecorder 가 뱉은 MP4 전체
 * @param {object} [info]  선택. 결과 정보를 채워서 돌려준다:
 *                         info.tracks = [{type, seconds, samples}],
 *                         info.truncated = {keptSeconds, droppedForSyncSeconds} (파일이 잘렸을 때만)
 * @returns {Uint8Array}  ftyp|moov|mdat 순서의 progressive MP4.
 *                        입력이 이미 progressive 면 입력을 그대로 돌려준다.
 * @throws {Error}  구조를 해석할 수 없을 때 (호출자는 원본 blob 으로 폴백하면 된다)
 */
export function remuxToProgressiveMp4(input, info = {}) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!u8.length) throw new Error('remux: 입력이 비어 있습니다 (empty input)');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  const top = scanBoxes(dv, 0, u8.length);
  if (!top.length) throw new Error('remux: MP4 박스를 찾을 수 없습니다 (not an MP4)');

  const moovBox = findBox(top, 'moov');
  if (!moovBox) throw new Error('remux: moov 박스가 없습니다 (no moov)');

  const moovKids = scanBoxes(dv, moovBox.body, moovBox.end);
  const mvexBox = findBox(moovKids, 'mvex');
  const moofs = top.filter(b => b.type === 'moof');

  /* 이미 progressive 인가?
     조각(moof)이 하나도 없는데 stbl 에 샘플이 들어 있으면 정상적인 파일이므로
     손대지 않고 그대로 돌려준다. (mvex 가 남아 있더라도 표가 채워져 있으면
     재생에는 문제가 없으니 굳이 다시 쓰지 않는다.) */
  if (moofs.length === 0) {
    if (hasPopulatedSampleTable(dv, moovKids)) return u8;
    throw new Error(mvexBox
      ? 'remux: mvex 는 있는데 moof 조각이 없습니다 (fragmented header without fragments)'
      : 'remux: 조각도 아니고 샘플 표도 비어 있습니다 (moov has no samples)');
  }

  const mvhdBox = findBox(moovKids, 'mvhd');
  if (!mvhdBox) throw new Error('remux: mvhd 박스가 없습니다 (no mvhd)');
  const mvhdVersion = dv.getUint8(mvhdBox.body);
  const movieTimescale = mvhdVersion === 1 ? dv.getUint32(mvhdBox.body + 20) : dv.getUint32(mvhdBox.body + 12);
  if (!movieTimescale) throw new Error('remux: mvhd timescale 이 0 입니다');

  /* ── trex 기본값 (트랙별 default_sample_duration/size/flags) ── */
  const trexDefaults = new Map();
  if (mvexBox) {
    for (const t of scanBoxes(dv, mvexBox.body, mvexBox.end)) {
      if (t.type !== 'trex') continue;
      trexDefaults.set(dv.getUint32(t.body + 4), {
        duration: dv.getUint32(t.body + 12),
        size: dv.getUint32(t.body + 16),
        flags: dv.getUint32(t.body + 20),
      });
    }
  }

  /* ── moov 의 trak 들에서 "껍데기"를 뜬다 (stsd/hdlr/tkhd 등은 원본 바이트 그대로) ── */
  const tracks = [];
  for (const trak of moovKids.filter(b => b.type === 'trak')) {
    tracks.push(readTrackTemplate(u8, dv, trak));
  }
  if (!tracks.length) throw new Error('remux: trak 이 하나도 없습니다 (no tracks)');
  const trackById = new Map(tracks.map(t => [t.id, t]));

  /* ── 모든 moof/traf/trun 을 걸어가며 샘플 수집 ──
     파일 꼬리가 잘려 있으면(마지막 조각 유실) 거기서 멈추고, 살릴 만큼 남았으면
     잘린 뒤쪽만 버린 채 계속 진행한다. 조금 짧은 영상이 "공유 못 하는 파일" 보다 낫다. */
  let truncated = null;
  for (let i = 0; i < moofs.length; i++) {
    try {
      collectFragment(dv, moofs[i], trackById, trexDefaults);
    } catch (e) {
      if (!e.truncatedAt) throw e;
      truncated = { fragment: i, total: moofs.length, detail: e.message, ...e.truncatedAt };
      break;
    }
  }

  const active = tracks.filter(t => t.samples.length > 0);
  if (!active.length) throw new Error('remux: 조각 안에 샘플이 없습니다 (no samples in fragments)');

  if (truncated) {
    /* 잘린 파일에서 "원래 몇 초였는지" 는 알 길이 없다 (fMP4 의 mvhd 길이는 0).
       그래서 "얼마나 잃었나" 로 거절하는 건 불가능하고, 의미도 없다 —
       거절하면 호출자는 원본 fMP4 로 돌아가는데 그건 애초에 공유가 안 되는 파일이다.
       남은 내용이 쓸 만하면(각 트랙 1초 이상) 살리고, 아니면(파싱이 근본적으로
       어긋난 경우) 실패시킨다. 잘렸다는 사실은 info 로 호출자에게 알린다. */
    const endOf = t => {
      const last = t.samples[t.samples.length - 1];
      return (last.dts + last.duration) / t.timescale;
    };
    const longest = Math.max(...active.map(endOf));
    const end = Math.min(...active.map(endOf));      // 트랙 간 공통 시간까지만 남긴다
    if (!(end >= 1)) {
      throw new Error(`${truncated.detail} (남은 내용이 ${end.toFixed(2)}초뿐이라 복구하지 않습니다)`);
    }
    for (const t of active) {
      while (t.samples.length > 1 && t.samples[t.samples.length - 1].dts / t.timescale > end) t.samples.pop();
    }
    info.truncated = { keptSeconds: +end.toFixed(2), droppedForSyncSeconds: +(longest - end).toFixed(2) };
  }

  /* ── 샘플 길이를 tfdt 기반 DTS 차이로 다시 계산 ──
     trun 의 sample_duration 만 누적하면 조각마다 리셋되는 tfdt 와 어긋나
     (프레임 드롭·조각 경계 갭이 있을 때) 영상이 점점 밀린다.
     DTS 가 단조 증가하면 실제 간격을 길이로 쓰는 편이 항상 더 정확하다. */
  for (const t of active) {
    normaliseDurations(t);
    normaliseCompositionOffsets(t);
  }

  /* 트랙별 실제 길이를 호출자에게 알려 준다.
     영상과 소리의 길이가 크게 다르면(예: 녹화 중 화면이 가려져 캔버스가 멈춤)
     화면 쪽에서 사용자에게 경고할 수 있다. */
  info.tracks = active.map(t => {
    const last = t.samples[t.samples.length - 1];
    return { type: t.handler === 'vide' ? 'video' : t.handler === 'soun' ? 'audio' : t.handler,
             seconds: +((last.dts + last.duration) / t.timescale).toFixed(2),
             samples: t.samples.length };
  });

  /* ── 트랙별 시작 시각(초) — 늦게 시작하는 트랙은 나중에 edts/elst 로 맞춘다 ── */
  let earliestStart = Infinity;
  for (const t of active) {
    t.startSeconds = t.samples[0].dts / t.timescale;
    if (t.startSeconds < earliestStart) earliestStart = t.startSeconds;
  }
  for (const t of active) {
    t.mediaDuration = 0;
    for (const s of t.samples) t.mediaDuration += s.duration;
    // 빈 편집(empty edit)으로 표현할 앞쪽 공백
    t.emptyEdit = Math.round((t.startSeconds - earliestStart) * movieTimescale);
    if (t.emptyEdit < 1) t.emptyEdit = 0;
    t.movieDuration = Math.round(t.mediaDuration / t.timescale * movieTimescale) + t.emptyEdit;
  }
  const movieDuration = Math.max(...active.map(t => t.movieDuration));

  /* ── 0.5초 단위 청크로 묶고, 시간 순으로 트랙을 교차 배치(interleave) ── */
  const chunkPlan = buildInterleavedChunks(active);

  let mdatPayload = 0;
  for (const c of chunkPlan) mdatPayload += c.bytes;

  // mdat 가 4GB 를 넘으면 64비트 크기 헤더가 필요하다 (브라우저에서는 사실상 안 생김)
  const largeMdat = mdatPayload + 8 > 0xfffffff0;
  const mdatHeaderLen = largeMdat ? 16 : 8;

  const ftyp = buildFtyp(active);

  /* moov 크기가 stco 값에 영향을 주고 stco 값이 다시 moov 크기에 영향을 준다.
     (32비트 오프셋 → 64비트 co64 로 넘어갈 때 크기가 변함) 고정점까지 반복. */
  let moovBytes = buildMoov(active, movieTimescale, movieDuration, u8, dv, mvhdBox, new Map());
  for (let iter = 0; iter < 8; iter++) {
    const offsets = new Map();
    let pos = ftyp.length + moovBytes.length + mdatHeaderLen;
    for (const c of chunkPlan) { offsets.set(c, pos); pos += c.bytes; }
    const next = buildMoov(active, movieTimescale, movieDuration, u8, dv, mvhdBox, offsets);
    const stable = next.length === moovBytes.length;
    moovBytes = next;
    if (stable) break;
    if (iter === 7) throw new Error('remux: moov 크기가 수렴하지 않습니다 (moov size did not settle)');
  }

  /* ── 최종 출력 ── */
  const total = ftyp.length + moovBytes.length + mdatHeaderLen + mdatPayload;
  const out = new Uint8Array(total);
  const odv = new DataView(out.buffer);
  let w = 0;
  out.set(ftyp, w); w += ftyp.length;
  out.set(moovBytes, w); w += moovBytes.length;

  if (largeMdat) {
    odv.setUint32(w, 1); out.set(typeBytes('mdat'), w + 4);
    odv.setBigUint64(w + 8, BigInt(mdatPayload + 16));
    w += 16;
  } else {
    odv.setUint32(w, mdatPayload + 8); out.set(typeBytes('mdat'), w + 4);
    w += 8;
  }

  // 샘플 복사 — 원본에서 이어져 있는 샘플은 한 번에 복사해 memcpy 횟수를 줄인다
  for (const c of chunkPlan) {
    const samples = c.track.samples;
    let runStart = -1, runEnd = -1;
    for (let i = c.first; i < c.first + c.count; i++) {
      const s = samples[i];
      if (runStart < 0) { runStart = s.offset; runEnd = s.offset + s.size; continue; }
      if (s.offset === runEnd) { runEnd += s.size; continue; }
      out.set(u8.subarray(runStart, runEnd), w); w += runEnd - runStart;
      runStart = s.offset; runEnd = s.offset + s.size;
    }
    if (runStart >= 0) { out.set(u8.subarray(runStart, runEnd), w); w += runEnd - runStart; }
  }
  if (w !== total) throw new Error(`remux: 출력 크기 불일치 (${w} != ${total})`);
  return out;
}

/* ────────────────────────── 보조 함수들 ────────────────────────── */

/** moov 안의 어느 trak 이든 stsz sample_count > 0 이면 "이미 progressive" 로 본다 */
function hasPopulatedSampleTable(dv, moovKids) {
  for (const trak of moovKids.filter(b => b.type === 'trak')) {
    const mdia = findBox(scanBoxes(dv, trak.body, trak.end), 'mdia');
    if (!mdia) continue;
    const minf = findBox(scanBoxes(dv, mdia.body, mdia.end), 'minf');
    if (!minf) continue;
    const stbl = findBox(scanBoxes(dv, minf.body, minf.end), 'stbl');
    if (!stbl) continue;
    const stbls = scanBoxes(dv, stbl.body, stbl.end);
    const stsz = findBox(stbls, 'stsz');
    if (stsz && dv.getUint32(stsz.body + 8) > 0) return true;
    const stz2 = findBox(stbls, 'stz2');
    if (stz2 && dv.getUint32(stz2.body + 8) > 0) return true;
  }
  return false;
}

/** trak 한 개에서 나중에 그대로 다시 쓸 정보를 뽑아낸다 */
function readTrackTemplate(u8, dv, trak) {
  const kids = scanBoxes(dv, trak.body, trak.end);
  const tkhd = findBox(kids, 'tkhd');
  if (!tkhd) throw new Error('remux: trak 에 tkhd 가 없습니다');
  const tkhdVersion = dv.getUint8(tkhd.body);
  const id = tkhdVersion === 1 ? dv.getUint32(tkhd.body + 20) : dv.getUint32(tkhd.body + 12);

  const mdiaBox = findBox(kids, 'mdia');
  if (!mdiaBox) throw new Error(`remux: trak ${id} 에 mdia 가 없습니다`);
  const mdia = scanBoxes(dv, mdiaBox.body, mdiaBox.end);

  const mdhd = findBox(mdia, 'mdhd');
  if (!mdhd) throw new Error(`remux: trak ${id} 에 mdhd 가 없습니다`);
  const mdhdVersion = dv.getUint8(mdhd.body);
  const timescale = mdhdVersion === 1 ? dv.getUint32(mdhd.body + 20) : dv.getUint32(mdhd.body + 12);
  if (!timescale) throw new Error(`remux: trak ${id} 의 mdhd timescale 이 0 입니다`);

  const hdlr = findBox(mdia, 'hdlr');
  if (!hdlr) throw new Error(`remux: trak ${id} 에 hdlr 가 없습니다`);
  const handler = String.fromCharCode(
    dv.getUint8(hdlr.body + 8), dv.getUint8(hdlr.body + 9),
    dv.getUint8(hdlr.body + 10), dv.getUint8(hdlr.body + 11));

  const minfBox = findBox(mdia, 'minf');
  if (!minfBox) throw new Error(`remux: trak ${id} 에 minf 가 없습니다`);
  const minf = scanBoxes(dv, minfBox.body, minfBox.end);
  const stblBox = findBox(minf, 'stbl');
  if (!stblBox) throw new Error(`remux: trak ${id} 에 stbl 이 없습니다`);
  const stsd = findBox(scanBoxes(dv, stblBox.body, stblBox.end), 'stsd');
  if (!stsd) throw new Error(`remux: trak ${id} 에 stsd 가 없습니다`);

  // vmhd / smhd / sthd / nmhd — 있는 걸 그대로 쓴다
  const mediaHeader = minf.find(b => b.type === 'vmhd' || b.type === 'smhd' || b.type === 'sthd' || b.type === 'nmhd');
  const dinf = findBox(minf, 'dinf');

  // stsd 첫 엔트리의 4CC (ftyp 호환 브랜드 판단용)
  let codec4cc = '';
  const entries = scanBoxes(dv, stsd.body + 8, stsd.end);
  if (entries.length) codec4cc = entries[0].type;

  return {
    id, timescale, handler, codec4cc,
    tkhdBytes: u8.subarray(tkhd.start, tkhd.end),   // 회전 행렬·가로세로·volume 보존용
    tkhdVersion,
    mdhdBytes: u8.subarray(mdhd.start, mdhd.end),   // language 보존용
    mdhdVersion,
    hdlrBytes: u8.subarray(hdlr.start, hdlr.end),
    stsdBytes: u8.subarray(stsd.start, stsd.end),   // avcC/esds 가 들어있다 — 절대 건드리지 않는다
    mediaHeaderBytes: mediaHeader ? u8.subarray(mediaHeader.start, mediaHeader.end) : null,
    dinfBytes: dinf ? u8.subarray(dinf.start, dinf.end) : null,
    samples: [],
  };
}

const FLAG_SAMPLE_IS_NON_SYNC = 0x00010000;

/** moof 하나를 해석해 각 트랙의 samples 에 밀어넣는다 */
function collectFragment(dv, moof, trackById, trexDefaults) {
  const trafs = scanBoxes(dv, moof.body, moof.end).filter(b => b.type === 'traf');
  /* 직전 traf 가 쓴 데이터의 끝(절대 오프셋). tfhd 에 기준 위치 플래그가 하나도
     없을 때 규격이 말하는 기본값이다. 해석할 수 없었으면 null. */
  let prevTrafEnd = null;

  for (let ti = 0; ti < trafs.length; ti++) {
    const traf = trafs[ti];
    const kids = scanBoxes(dv, traf.body, traf.end);
    const tfhd = findBox(kids, 'tfhd');
    if (!tfhd) { prevTrafEnd = null; continue; }

    const tfhdFlags = dv.getUint32(tfhd.body) & 0xffffff;
    let p = tfhd.body + 4;
    const trackId = dv.getUint32(p); p += 4;
    const track = trackById.get(trackId);
    if (!track) { prevTrafEnd = null; continue; } // moov 에 없는 트랙 — 무시

    /* 데이터 기준 위치 (ISO/IEC 14496-12, 8.8.7.1)
       - base-data-offset-present(0x01): 절대 파일 오프셋이 명시됨
       - default-base-is-moof(0x020000): moof 박스 시작이 기준
       - 둘 다 없으면: 첫 traf 는 moof 시작, 그 뒤 traf 는 "직전 traf 데이터의 끝" */
    let baseOffset;
    if (tfhdFlags & 0x000001) { baseOffset = Number(dv.getBigUint64(p)); p += 8; }
    else if (tfhdFlags & 0x020000) baseOffset = moof.start;
    else baseOffset = (ti === 0 || prevTrafEnd === null) ? moof.start : prevTrafEnd;
    if (tfhdFlags & 0x000002) p += 4; // sample_description_index

    const trex = trexDefaults.get(trackId) || { duration: 0, size: 0, flags: 0 };
    let defDuration = trex.duration, defSize = trex.size, defFlags = trex.flags;
    if (tfhdFlags & 0x000008) { defDuration = dv.getUint32(p); p += 4; }
    if (tfhdFlags & 0x000010) { defSize = dv.getUint32(p); p += 4; }
    if (tfhdFlags & 0x000020) { defFlags = dv.getUint32(p); p += 4; }

    // tfdt: 이 조각 첫 샘플의 절대 DTS
    const tfdt = findBox(kids, 'tfdt');
    let dts = track.samples.length
      ? track.samples[track.samples.length - 1].dts + track.samples[track.samples.length - 1].duration
      : 0;
    if (tfdt) {
      dts = dv.getUint8(tfdt.body) === 1
        ? Number(dv.getBigUint64(tfdt.body + 4))
        : dv.getUint32(tfdt.body + 4);
    }

    let cursor = baseOffset;
    for (const trun of kids.filter(b => b.type === 'trun')) {
      const version = dv.getUint8(trun.body);
      const trunFlags = dv.getUint32(trun.body) & 0xffffff;
      let q = trun.body + 4;
      const count = dv.getUint32(q); q += 4;
      if (trunFlags & 0x000001) { cursor = baseOffset + dv.getInt32(q); q += 4; } // data-offset (부호 있음)
      let firstSampleFlags = null;
      if (trunFlags & 0x000004) { firstSampleFlags = dv.getUint32(q); q += 4; }

      /* sample_count 를 믿기 전에 검증한다.
         sample_count 는 32비트라 20바이트짜리 trun 이 "샘플 40억 개" 라고 우길 수 있다.
         샘플마다 객체를 하나씩 만들므로 그대로 믿으면 루프가 끝나기 전에 힙이 터진다
         (측정: 500만 개에서 595MB·6.5초, 40억 개에서는 프로세스 사망 = 폰에서는 탭 강제종료).
         아래 두 검사로 count 가 항상 파일 크기 안에서 끝나도록 묶는다. */
      const perSampleBytes =
        ((trunFlags & 0x000100) ? 4 : 0) + ((trunFlags & 0x000200) ? 4 : 0) +
        ((trunFlags & 0x000400) ? 4 : 0) + ((trunFlags & 0x000800) ? 4 : 0);
      if (perSampleBytes) {
        // 샘플별 표가 있으면 trun 박스 안에 실제로 들어갈 수 있는 개수여야 한다
        if (q + count * perSampleBytes > trun.end) {
          throw new Error(`remux: trun 의 sample_count 가 박스 크기를 넘습니다 (count=${count}, trun=${trun.end - trun.start}바이트)`);
        }
      } else if (count && !defSize) {
        /* 샘플별 표도 없고 tfhd/trex 기본 크기도 0 이면 샘플 크기를 알 방법이 없다.
           예전에는 크기 0 짜리 샘플을 count 만큼 만들어 mdat 가 텅 빈 MP4 를 조용히
           내놨다(그리고 count 가 크면 그대로 OOM). 여기서 분명히 실패시킨다. */
        throw new Error('remux: 샘플 크기를 알 수 없습니다 (trun/tfhd/trex 어디에도 sample_size 가 없음)');
      }
      // perSampleBytes 가 0 이고 defSize > 0 이면 cursor 가 매번 defSize 씩 늘어나므로
      // 아래 범위 검사가 파일 크기 안에서 반드시 루프를 끝낸다.

      for (let i = 0; i < count; i++) {
        let duration = defDuration, size = defSize, flags = defFlags, cto = 0;
        if (trunFlags & 0x000100) { duration = dv.getUint32(q); q += 4; }
        if (trunFlags & 0x000200) { size = dv.getUint32(q); q += 4; }
        if (trunFlags & 0x000400) { flags = dv.getUint32(q); q += 4; }
        else if (i === 0 && firstSampleFlags !== null) flags = firstSampleFlags;
        if (trunFlags & 0x000800) { cto = version === 0 ? dv.getUint32(q) : dv.getInt32(q); q += 4; }

        /* 샘플이 파일 밖을 가리키면 여기서 바로 멈춘다.
           (잘린 녹화 파일, 또는 기준 오프셋 해석 실패) 이걸 안 잡으면 나중에
           subarray 가 조용히 잘린 바이트를 복사해 0 으로 채워진 깨진 MP4 가
           만들어진다 — 호출자가 원본으로 폴백할 기회를 잃는다. */
        if (!(cursor >= 0) || cursor + size > dv.byteLength) {
          /* 꼬리가 잘린 녹화(마지막 ondataavailable 조각 유실)는 흔하다.
             여기서 무조건 실패시키면 호출자가 원본 fMP4 로 폴백하는데, 그게 바로
             카톡·갤러리가 거부하는 파일이다. 그래서 "여기까지 수집" 으로 표시하고
             호출자가 살릴지(꼬리만 날림) 실패시킬지 판단하게 한다. */
          const err = new Error(`remux: 샘플이 파일 범위를 벗어납니다 (sample ${cursor}+${size} > ${dv.byteLength}) — 잘린 파일일 수 있습니다`);
          // 이 조각에서 몇 개를 못 읽었는지 알려 준다 (호출자가 "몇 초를 잃었나" 로 판단)
          err.truncatedAt = { trackId, lostSamples: count - i, timescale: track.timescale };
          throw err;
        }

        track.samples.push({
          offset: cursor,
          size,
          duration,
          cto,
          dts,
          sync: (flags & FLAG_SAMPLE_IS_NON_SYNC) === 0,
        });
        cursor += size;
        dts += duration;
      }
    }
    prevTrafEnd = cursor;
  }
}

/**
 * 샘플 길이를 DTS 간격으로 재계산한다.
 * DTS 가 단조 증가할 때만 적용(그렇지 않으면 trun 값을 믿는다).
 */
function normaliseDurations(track) {
  const s = track.samples;
  let monotonic = true;
  for (let i = 1; i < s.length; i++) {
    if (s[i].dts < s[i - 1].dts) { monotonic = false; break; }
  }
  if (monotonic) {
    for (let i = 0; i < s.length - 1; i++) {
      const d = s[i + 1].dts - s[i].dts;
      if (d > 0) s[i].duration = d;
    }
  }
  // 마지막 샘플 길이가 비어 있으면 직전 값을 빌려온다
  const last = s[s.length - 1];
  if (!last.duration) last.duration = s.length > 1 ? s[s.length - 2].duration : track.timescale;
  for (const x of s) if (!x.duration) x.duration = 1;
}

/**
 * CTS(합성 시각) 오프셋의 바닥을 0 으로 내린다.
 *
 * B프레임이 있으면 인코더는 보통 모든 샘플의 ctts 를 +N 프레임만큼 띄워 놓는다.
 * (재정렬 지연) 그러면 첫 영상 프레임의 표시 시각이 0 이 아니라 0.066초 같은
 * 값이 되어, 0 에서 시작하는 오디오보다 영상이 그만큼 늦게 나온다.
 * ffmpeg 은 이걸 edts/elst(media_time=지연) 로 보정하지만, 편집 리스트를
 * 무시하는 안드로이드 플레이어도 많다.
 *
 * 모든 오프셋에서 최솟값을 똑같이 빼면 DTS(디코딩 순서·시각)는 전혀 건드리지
 * 않은 채 표시 시각만 통째로 앞당겨진다. 프레임 사이의 상대 간격은 완전히
 * 그대로이고(=재생 결과가 바뀌지 않는다), 영상이 오디오보다 늦는 양만 줄어든다.
 *
 * 최솟값을 0 으로 만드는 것이지 "첫 프레임 PTS = 0" 을 만드는 게 아니다.
 * 첫 프레임까지 정확히 0 으로 끌어내리려면 오프셋이 음수가 되어야 하는데
 * (ctts version 1), 그걸 못 읽는 낡은 파서가 있어서 일부러 하지 않는다.
 * 남는 지연은 보통 한 프레임(30fps 기준 33ms)이라 귀·눈으로 구분되지 않는다.
 * 덤으로 오프셋이 전부 0 이상이 되어 호환성이 가장 좋은 ctts version 0 이 쓰인다.
 */
function normaliseCompositionOffsets(track) {
  let min = Infinity;
  for (const s of track.samples) if (s.cto < min) min = s.cto;
  if (!Number.isFinite(min) || min === 0) return;
  for (const s of track.samples) s.cto -= min;
}

/** 각 트랙을 0.5초 청크로 자르고, 시작 시각 순으로 하나의 배치 계획을 만든다 */
function buildInterleavedChunks(tracks) {
  const all = [];
  for (const t of tracks) {
    t.chunks = [];
    const step = Math.max(1, Math.round(t.timescale * 0.5)); // 0.5초
    let cur = null;
    for (let i = 0; i < t.samples.length; i++) {
      const s = t.samples[i];
      if (!cur || (s.dts - cur.startDts) >= step) {
        cur = { track: t, startDts: s.dts, startSeconds: s.dts / t.timescale, first: i, count: 0, bytes: 0 };
        t.chunks.push(cur);
        all.push(cur);
      }
      cur.count++;
      cur.bytes += s.size;
    }
  }
  // 시간 순 정렬. Array#sort 는 안정 정렬이라 같은 시각이면 트랙 내 순서가 유지된다.
  all.sort((a, b) => a.startSeconds - b.startSeconds);
  return all;
}

/** 실제 코덱에 맞춰 ftyp 을 만든다 */
function buildFtyp(tracks) {
  const brands = ['mp42', 'isom', 'iso2'];
  const codecs = new Set(tracks.map(t => t.codec4cc));
  if (codecs.has('avc1') || codecs.has('avc3')) brands.push('avc1');
  brands.push('mp41');
  const out = new Uint8Array(8 + 8 + brands.length * 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length);
  out.set(typeBytes('ftyp'), 4);
  out.set(typeBytes('mp42'), 8);   // major_brand
  dv.setUint32(12, 0);             // minor_version
  brands.forEach((b, i) => out.set(typeBytes(b), 16 + i * 4));
  return out;
}

/* ── 표(table) 빌더들 ── */

function buildStts(samples) {
  // (count, delta) 런 렝스
  const runs = [];
  for (const s of samples) {
    const last = runs.length ? runs[runs.length - 1] : null;
    if (last && last[1] === s.duration) last[0]++;
    else runs.push([1, s.duration]);
  }
  return fullBox('stts', 0, 0, 4 + runs.length * 8, (dv, base) => {
    dv.setUint32(base, runs.length);
    let o = base + 4;
    for (const r of runs) { dv.setUint32(o, r[0]); dv.setUint32(o + 4, r[1]); o += 8; }
  });
}

function buildCtts(samples) {
  const runs = [];
  let anyNegative = false;
  for (const s of samples) {
    if (s.cto < 0) anyNegative = true;
    const last = runs.length ? runs[runs.length - 1] : null;
    if (last && last[1] === s.cto) last[0]++;
    else runs.push([1, s.cto]);
  }
  const version = anyNegative ? 1 : 0;
  return fullBox('ctts', version, 0, 4 + runs.length * 8, (dv, base) => {
    dv.setUint32(base, runs.length);
    let o = base + 4;
    for (const r of runs) {
      dv.setUint32(o, r[0]);
      if (version === 1) dv.setInt32(o + 4, r[1]); else dv.setUint32(o + 4, r[1]);
      o += 8;
    }
  });
}

function buildStsc(chunks) {
  // (first_chunk, samples_per_chunk, sample_description_index)
  const runs = [];
  chunks.forEach((c, idx) => {
    const last = runs.length ? runs[runs.length - 1] : null;
    if (!last || last[1] !== c.count) runs.push([idx + 1, c.count, 1]);
  });
  return fullBox('stsc', 0, 0, 4 + runs.length * 12, (dv, base) => {
    dv.setUint32(base, runs.length);
    let o = base + 4;
    for (const r of runs) {
      dv.setUint32(o, r[0]); dv.setUint32(o + 4, r[1]); dv.setUint32(o + 8, r[2]);
      o += 12;
    }
  });
}

function buildStsz(samples) {
  // 모든 샘플 크기가 같으면 표를 생략할 수 있다 (오디오에서 가끔 발생)
  const first = samples[0].size;
  let uniform = true;
  for (const s of samples) if (s.size !== first) { uniform = false; break; }
  // sample_size=0 은 "표가 뒤따른다" 는 뜻이라 생략 형식으로 쓸 수 없다
  if (uniform && first > 0) {
    return fullBox('stsz', 0, 0, 8, (dv, base) => {
      dv.setUint32(base, first);
      dv.setUint32(base + 4, samples.length);
    });
  }
  return fullBox('stsz', 0, 0, 8 + samples.length * 4, (dv, base) => {
    dv.setUint32(base, 0);
    dv.setUint32(base + 4, samples.length);
    let o = base + 8;
    for (const s of samples) { dv.setUint32(o, s.size); o += 4; }
  });
}

function buildChunkOffsetBox(offsets) {
  let needs64 = false;
  for (const o of offsets) if (o > 0xfffffffe) { needs64 = true; break; }
  if (needs64) {
    return fullBox('co64', 0, 0, 4 + offsets.length * 8, (dv, base) => {
      dv.setUint32(base, offsets.length);
      let o = base + 4;
      for (const v of offsets) { dv.setBigUint64(o, BigInt(v)); o += 8; }
    });
  }
  return fullBox('stco', 0, 0, 4 + offsets.length * 4, (dv, base) => {
    dv.setUint32(base, offsets.length);
    let o = base + 4;
    for (const v of offsets) { dv.setUint32(o, v); o += 4; }
  });
}

function buildStss(samples) {
  const idx = [];
  for (let i = 0; i < samples.length; i++) if (samples[i].sync) idx.push(i + 1);
  /* stss 가 없으면 규격상 "모든 샘플이 싱크 샘플" 이라는 뜻이다(14496-12 8.6.2).
     그러므로 생략해도 되는 경우는 '전부 키프레임' 일 때뿐이고,
     싱크 샘플이 하나도 없을 때 생략하면 정반대 의미가 된다 — 이때는
     entry_count 0 인 stss 를 써서 "키프레임 없음" 을 명시한다. */
  if (idx.length && idx.length === samples.length) return null; // 전부 키프레임이면 stss 생략
  return fullBox('stss', 0, 0, 4 + idx.length * 4, (dv, base) => {
    dv.setUint32(base, idx.length);
    let o = base + 4;
    for (const v of idx) { dv.setUint32(o, v); o += 4; }
  });
}

/** edts/elst — 늦게 시작하는 트랙 앞에 빈 구간을 넣어 A/V 싱크를 맞춘다 */
function buildEdts(track, movieTimescale) {
  if (!track.emptyEdit) return null;
  const playDuration = Math.round(track.mediaDuration / track.timescale * movieTimescale);
  const elst = fullBox('elst', 0, 0, 4 + 2 * 12, (dv, base) => {
    dv.setUint32(base, 2);
    // 1) 빈 편집: media_time = -1
    dv.setUint32(base + 4, track.emptyEdit);
    dv.setInt32(base + 8, -1);
    dv.setUint32(base + 12, 0x00010000);
    // 2) 실제 내용
    dv.setUint32(base + 16, playDuration);
    dv.setInt32(base + 20, 0);
    dv.setUint32(base + 24, 0x00010000);
  });
  return containerBox('edts', [elst]);
}

/** 원본 박스를 복사한 뒤 duration 필드만 덮어쓴다 (행렬·언어·해상도 등은 그대로 보존) */
function copyWithDuration(srcBytes, version, durationOffsetInBody, value, extraPatch) {
  const out = srcBytes.slice(); // 헤더 몇십 바이트 복사 — 무시해도 될 비용
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const at = 8 + durationOffsetInBody;
  if (version === 1) dv.setBigUint64(at, BigInt(Math.max(0, Math.round(value))));
  else dv.setUint32(at, Math.min(0xfffffffe, Math.max(0, Math.round(value))));
  if (extraPatch) extraPatch(dv, out);
  return out;
}

/** moov 전체를 만든다. chunkOffsets 가 비어 있으면 0 으로 채워 크기만 재는 용도. */
function buildMoov(tracks, movieTimescale, movieDuration, u8, dv, mvhdBox, chunkOffsets) {
  const traks = tracks.map(t => {
    const stblParts = [t.stsdBytes, buildStts(t.samples)];

    if (t.samples.some(s => s.cto !== 0)) stblParts.push(buildCtts(t.samples));

    if (t.handler === 'vide') {
      const stss = buildStss(t.samples);
      if (stss) stblParts.push(stss);
    }

    stblParts.push(buildStsc(t.chunks));
    stblParts.push(buildStsz(t.samples));
    stblParts.push(buildChunkOffsetBox(t.chunks.map(c => chunkOffsets.get(c) || 0)));

    const stbl = containerBox('stbl', stblParts);

    const minfParts = [];
    if (t.mediaHeaderBytes) minfParts.push(t.mediaHeaderBytes);
    minfParts.push(t.dinfBytes || defaultDinf());
    minfParts.push(stbl);

    // tkhd: version 0 → duration 은 body+20, version 1 → body+28.
    // flags 는 enabled|in-movie|in-preview(7) 로 고정한다.
    const tkhd = copyWithDuration(
      t.tkhdBytes, t.tkhdVersion, t.tkhdVersion === 1 ? 28 : 20, t.movieDuration,
      (d) => { d.setUint8(9, 0); d.setUint8(10, 0); d.setUint8(11, 7); });

    // mdhd: version 0 → duration 은 body+16, version 1 → body+24
    const mdhd = copyWithDuration(
      t.mdhdBytes, t.mdhdVersion, t.mdhdVersion === 1 ? 24 : 16, t.mediaDuration);

    const trakParts = [tkhd];
    const edts = buildEdts(t, movieTimescale);
    if (edts) trakParts.push(edts);
    trakParts.push(containerBox('mdia', [mdhd, t.hdlrBytes, containerBox('minf', minfParts)]));
    return containerBox('trak', trakParts);
  });

  // mvhd: version 0 → duration 은 body+16, version 1 → body+24. mvex 는 넣지 않는다.
  const mvhdSrc = u8.subarray(mvhdBox.start, mvhdBox.end);
  const mvhdVersion = dv.getUint8(mvhdBox.body);
  const mvhd = copyWithDuration(mvhdSrc, mvhdVersion, mvhdVersion === 1 ? 24 : 16, movieDuration);

  return containerBox('moov', [mvhd, ...traks]);
}

/** dinf 가 없는 입력을 위한 표준 "데이터는 이 파일 안에" 선언 */
function defaultDinf() {
  const url = fullBox('url ', 0, 1, 0, null);
  const dref = fullBox('dref', 0, 0, 4 + url.length, (dv, base, out) => {
    dv.setUint32(base, 1);
    out.set(url, base + 4);
  });
  return containerBox('dinf', [dref]);
}

/* ────────────────────────── 편의 API ────────────────────────── */

/** 입력이 조각난 MP4 인지 빠르게 판별 (moof 존재 여부) */
export function isFragmentedMp4(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const top = scanBoxes(dv, 0, u8.length);
  return top.some(b => b.type === 'moof');
}

/**
 * Blob → progressive MP4 Blob.
 * MP4 가 아니거나(예: WebM 폴백) 변환에 실패하면 원본 Blob 을 그대로 돌려준다.
 * 실패를 삼키지 않고 알고 싶으면 remuxToProgressiveMp4 를 직접 쓰면 된다.
 */
export async function remuxBlob(blob) {
  if (!/mp4/i.test(blob.type || '')) return blob;
  try {
    const buf = await blob.arrayBuffer();
    const out = remuxToProgressiveMp4(buf);
    return new Blob([out], { type: 'video/mp4' });
  } catch (e) {
    /* 설명대로 "실패하면 원본" 이 되려면 여기서 반드시 삼켜야 한다.
       remuxToProgressiveMp4 는 조금이라도 수상한 입력(잘린 파일, 범위를 벗어난
       샘플 오프셋, 크기를 알 수 없는 trun ...)에 전부 throw 하므로, 이 catch 가
       없으면 저장 자체가 실패해 버린다. 원본은 최소한 재생은 되니 그걸 돌려준다. */
    console.warn('remux 실패 — 원본 그대로 사용합니다:', e && e.message);
    return blob;
  }
}
