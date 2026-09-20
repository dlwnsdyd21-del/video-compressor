/* 브라우저 안에서 영상을 다시 인코딩해 용량을 줄이는 핵심 로직.
   화면(UI)과 분리해 두어 test/browser-test.html 에서 그대로 테스트할 수 있다. */

const MB = 1048576;

/* 영상 길이·해상도 읽기 */
export function loadVideo(url) {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    v.src = url; v.playsInline = true; v.muted = true; v.preload = 'auto';
    v.onloadedmetadata = () => (v.duration && isFinite(v.duration))
      ? res(v) : rej(new Error('영상 길이를 읽을 수 없어요'));
    v.onerror = () => rej(new Error('이 영상 형식은 브라우저에서 열 수 없어요'));
  });
}

export async function probe(file) {
  const url = URL.createObjectURL(file);
  try {
    const v = await loadVideo(url);
    return { dur: v.duration, w: v.videoWidth, h: v.videoHeight, size: file.size };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* 브라우저가 받아주는 최대 배속. 이보다 크게 넣으면 NotSupportedError 가 나고
   playbackRate 가 1 로 되돌아간다(= 배속이 통째로 무시된다). 측정값: 16 까지 OK, 17 부터 오류. */
export const MAX_SPEED = 15;

/* 실제로 낼 수 있는 배속을 짧게 재 본다.
   15배로 설정해도 영상을 해독하는 속도가 못 따라가면 실제로는 10~12배에 그친다
   (휴대폰은 더 낮다). 미리 재 두면 예상 용량·시간을 맞게 보여줄 수 있다. */
export async function measureSpeed(file, speed, ms = 800) {
  if (speed <= 1) return speed;
  const url = URL.createObjectURL(file);
  try {
    const v = await loadVideo(url);
    v.muted = true;
    try { v.playbackRate = speed; } catch { return speed; }
    // 앞부분은 버퍼링 때문에 느릴 수 있어 조금 건너뛰고 잰다
    v.currentTime = Math.min(1, v.duration / 4);
    await new Promise(r => { v.onseeked = r; setTimeout(r, 500); });
    const t0 = v.currentTime, w0 = performance.now();
    try { await v.play(); } catch { return speed; }
    await new Promise(r => setTimeout(r, ms));
    const measured = (v.currentTime - t0) / ((performance.now() - w0) / 1000);
    v.pause();
    if (!isFinite(measured) || measured <= 0) return speed;
    return Math.min(speed, Math.max(1, measured));
  } catch {
    return speed;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* 비트레이트에 맞는 세로 해상도 */
const heightFor = bps => bps > 2500000 ? 1080 : bps > 1200000 ? 720 : bps > 600000 ? 480 : bps > 300000 ? 360 : 240;

/* 목표 용량·배속·음소거로부터 인코딩 계획과 예상치를 계산 */
export function plan(meta, { targetMB = 10, speed = 1, mute = false, realSpeed = 0 } = {}) {
  const limit = Math.max(1, targetMB) * MB;
  speed = Math.min(Math.max(speed, 0.5), MAX_SPEED);
  // realSpeed(실측 배속)가 있으면 그걸로 결과 길이를 잡는다. 없으면 설정값 그대로.
  const effective = realSpeed > 0 ? Math.min(realSpeed, speed) : speed;
  const outDur = meta.dur / effective;
  const audioBps = mute ? 0 : 64000;
  // 목표보다 8% 작게 잡아 여유를 둔다 (MediaRecorder는 비트레이트를 정확히 지키지 않는다)
  const wanted = Math.max(80000, Math.floor(limit * 8 * 0.92 / outDur) - audioBps);
  /* 두 가지 한계로 잘라 낸다.
     1) 원본보다 좋은 화질로 만들 수는 없다 (배속을 쓰면 1초에 담기는 내용이 늘어난다)
     2) 브라우저 인코더가 실제로 낼 수 있는 상한 (없으면 "15배속 1초짜리에 9MB" 같은
        터무니없는 예상치가 나온다) */
  const srcBps = meta.size * 8 / meta.dur * effective;
  const MAX_VIDEO_BPS = 12000000;
  const videoBps = Math.round(Math.min(wanted, srcBps * 0.98, MAX_VIDEO_BPS));
  const h = heightFor(videoBps);
  const scale = Math.min(1, h / Math.min(meta.w, meta.h));
  return {
    limit, targetMB, outDur, speed, effective, mute, audioBps, videoBps,
    w: Math.round(meta.w * scale / 2) * 2,
    h: Math.round(meta.h * scale / 2) * 2,
    estBytes: Math.min(limit * 0.92, (videoBps + audioBps) * outDur / 8),
    limitedBySource: videoBps < wanted,
  };
}

export function pickMime() {
  const list = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',   // H.264 베이스라인 — 호환성이 가장 넓다
    'video/mp4;codecs=avc1.4D401F,mp4a.40.2',   // 메인 프로파일
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return list.find(m => MediaRecorder.isTypeSupported(m)) || '';
}

/* 한 번 녹화. factor 는 재시도 시 비트레이트를 더 낮추는 계수.

   중요: 브라우저는 탭이 화면에서 벗어나면 requestAnimationFrame 을 멈춘다.
   그대로 두면 캔버스가 갱신되지 않아 "1프레임짜리 멈춘 영상"이 녹화된다.
   그래서 화면에서 벗어나면 재생·녹화를 함께 멈추고, 돌아오면 이어서 한다. */
function record(url, meta, p, factor, onProgress, onPause) {
  return loadVideo(url).then(v => new Promise((res, rej) => {
    v.muted = false;
    /* 범위를 벗어난 값을 넣으면 예외가 나면서 배속이 1 로 되돌아간다 — 반드시 막는다 */
    try { v.playbackRate = Math.min(Math.max(p.speed, 0.5), MAX_SPEED); }
    catch { v.playbackRate = 1; }

    const canvas = document.createElement('canvas');
    canvas.width = p.w; canvas.height = p.h;
    const ctx = canvas.getContext('2d', { alpha: false });
    const stream = canvas.captureStream(30);

    let ac = null;
    if (!p.mute) {
      // 스피커로 내보내지 않고 녹화에만 쓴다
      ac = new AudioContext();
      const dest = ac.createMediaStreamDestination();
      ac.createMediaElementSource(v).connect(dest);
      dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    }

    const mime = pickMime();
    if (!mime) return rej(new Error('이 브라우저는 영상 녹화를 지원하지 않아요'));
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: Math.max(80000, Math.round(p.videoBps * factor)),
      ...(p.mute ? {} : { audioBitsPerSecond: p.audioBps }),
    });
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);

    let raf, stopped = false, frames = 0;
    const cleanup = () => {
      stopped = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      try { ac && ac.close(); } catch {}
    };
    const draw = () => {
      if (stopped) return;
      if (!v.paused) {
        ctx.drawImage(v, 0, 0, p.w, p.h);
        frames++;
        onProgress?.(Math.min(1, v.currentTime / meta.dur));
      }
      raf = requestAnimationFrame(draw);
    };

    // 화면에서 벗어나면 멈추고, 돌아오면 이어서 한다
    function onVisibility() {
      if (stopped) return;
      if (document.hidden) {
        v.pause();
        try { rec.state === 'recording' && rec.pause(); } catch {}
        onPause?.(true);
      } else {
        try { rec.state === 'paused' && rec.resume(); } catch {}
        v.play().catch(() => {});
        onPause?.(false);
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(draw);   // 멈춰 있던 그리기 루프를 다시 돌린다
      }
    }
    document.addEventListener('visibilitychange', onVisibility);

    rec.onstop = () => {
      cleanup();
      if (frames < 2) return rej(new Error('화면이 꺼져 있어 영상이 녹화되지 않았어요. 화면을 켠 채 다시 시도해 주세요.'));
      res({ blob: new Blob(chunks, { type: mime.split(';')[0] }), mime, frames });
    };
    rec.onerror = () => { cleanup(); rej(new Error('녹화 중 오류가 났어요')); };
    v.onended = () => { try { rec.stop(); } catch {} };
    v.onerror = () => { cleanup(); rej(new Error('재생 중 오류가 났어요')); };

    const start = () => { rec.start(1000); v.play().then(draw).catch(e => { cleanup(); rej(e); }); };
    const startWhenVisible = () => {
      if (!document.hidden) return start();
      // 화면이 가려진 채로 시작하면 캔버스가 갱신되지 않는다. 돌아올 때까지 기다린다.
      onPause?.(true);
      const wait = () => {
        if (document.hidden || stopped) return;
        document.removeEventListener('visibilitychange', wait);
        onPause?.(false);
        start();
      };
      document.addEventListener('visibilitychange', wait);
    };
    ac ? ac.resume().then(startWhenVisible, startWhenVisible) : startWhenVisible();
  }));
}

/* MediaRecorder 의 MP4 는 조각난(fragmented) 형식이라 카카오톡·갤러리가 거부한다.
   remux.js 가 있으면 일반 MP4 로 다시 포장하고, 실패하면 원본을 그대로 쓴다. */
export async function repackage(blob) {
  if (!blob.type.includes('mp4')) return { blob, remuxed: false, warnings: [] };
  try {
    const { remuxToProgressiveMp4 } = await import('./remux.js');
    const info = {};
    const out = remuxToProgressiveMp4(await blob.arrayBuffer(), info);
    const warnings = [];

    // 영상과 소리의 길이가 많이 다르면 녹화가 중간에 멈춘 것이다 (화면이 가려졌을 때)
    const v = info.tracks?.find(t => t.type === 'video');
    const a = info.tracks?.find(t => t.type === 'audio');
    if (v && a && Math.abs(v.seconds - a.seconds) > 1.5) {
      warnings.push(`녹화 도중 화면이 가려져서 영상이 ${Math.min(v.seconds, a.seconds).toFixed(0)}초에서 멈췄어요. 이 화면을 계속 켜 둔 채 다시 시도해 주세요.`);
    }
    if (info.truncated) warnings.push('영상 끝부분 일부가 잘렸어요.');

    return { blob: new Blob([out], { type: 'video/mp4' }), remuxed: true, info, warnings };
  } catch (e) {
    console.warn('remux 실패, 원본을 그대로 사용합니다:', e);
    // 조각난 MP4 그대로면 카톡·갤러리가 거부할 수 있으므로 조용히 넘기지 않는다
    return {
      blob, remuxed: false, error: e,
      warnings: ['영상 포장을 고치지 못했어요. 일부 앱(카카오톡 등)에서 안 열릴 수 있어요.'],
    };
  }
}

/* 전체 과정: 목표 용량에 맞을 때까지 최대 4번 녹화 → 다시 포장 */
export async function compress(file, meta, opts, { onProgress, onAttempt, onPause, onMeasure } = {}) {
  /* 배속을 쓰면 먼저 실제로 낼 수 있는 속도를 재고, 그 값으로 계획을 세운다.
     그래야 목표 용량을 한 번에 맞추고, 남은 시간도 맞게 보여줄 수 있다. */
  let p = plan(meta, opts);
  if (opts.speed > 1) {
    onMeasure?.();
    const realSpeed = await measureSpeed(file, p.speed);
    p = plan(meta, { ...opts, realSpeed });
  }
  const url = URL.createObjectURL(file);
  try {
    let factor = 1, out, attempt;
    for (attempt = 1; attempt <= 4; attempt++) {
      onAttempt?.(attempt);
      out = await record(url, meta, p, factor, onProgress, onPause);
      if (out.blob.size <= p.limit) break;
      factor *= (p.limit / out.blob.size) * 0.9;
    }
    const packed = await repackage(out.blob);
    // 실제로 나온 배속 (영상 해독이 못 따라가면 설정값보다 낮다)
    const outSeconds = packed.info?.tracks?.reduce((s, t) => Math.max(s, t.seconds), 0) || 0;
    const actualSpeed = outSeconds > 0 ? meta.dur / outSeconds : p.effective;
    return {
      blob: packed.blob, plan: p, attempts: Math.min(attempt, 4), actualSpeed,
      remuxed: packed.remuxed, info: packed.info, warnings: packed.warnings || [],
      withinTarget: packed.blob.size <= p.limit,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
