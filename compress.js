/* 브라우저 안에서 영상을 다시 인코딩해 용량을 줄이는 핵심 로직.
   화면(UI)과 분리해 두어 test/browser-test.html 에서 그대로 테스트할 수 있다. */

const MB = 1048576;

/* 영상 길이·해상도 읽기.
   시간 제한이 없으면, 브라우저가 파일을 못 열고 조용히 가만히 있을 때
   (큰 파일·낯선 코덱) 화면이 영원히 "준비 중" 에서 멈춘다. */
export function loadVideo(url, timeoutMs = 30000) {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    const timer = setTimeout(
      () => rej(new Error('영상을 여는 데 너무 오래 걸려요. 다른 파일로 시도해 주세요.')),
      timeoutMs);
    const done = fn => (...a) => { clearTimeout(timer); fn(...a); };
    v.src = url; v.playsInline = true; v.muted = true; v.preload = 'auto';
    v.onloadedmetadata = done(() => (v.duration && isFinite(v.duration))
      ? res(v) : rej(new Error('영상 길이를 읽을 수 없어요')));
    v.onerror = done(() => rej(new Error('이 영상 형식은 브라우저에서 열 수 없어요')));
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
    // play() 가 영영 안 끝나는 기기가 있어서 기다리는 시간을 제한한다
    try { await Promise.race([v.play(), new Promise(r => setTimeout(r, 3000))]); } catch { return speed; }
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

const FPS = 30;
const FREEZE_PAUSE_MS = 1500;   // 재생이 이만큼 안 흐르면 녹화를 세운다 (정지 화면이 쌓이지 않게)
const STALL_WARN_MS = 6000;     // 이만큼 재생이 멈춰 있으면 되살리기 시도 + 사용자에게 알림
const STALL_GIVEUP_MS = 20000;  // 그래도 안 되면 지금까지 녹화한 것만 쓰고 끝낸다

/* 한 번 녹화. factor 는 재시도 시 비트레이트를 더 낮추는 계수.

   이 함수가 다루는 까다로운 점 세 가지:

   1) 그리기 시계로 requestAnimationFrame 을 쓰면 안 된다.
      브라우저는 탭이 가려지거나(다른 창에 완전히 덮임) 화면에서 벗어나면 rAF 를 멈춘다.
      이때 소리는 계속 녹음되는데 캔버스만 멈춰서 "중간부터 화면이 정지한 영상"이 된다.
      타이머(setInterval)는 창이 덮여도 계속 돌기 때문에 타이머를 주 시계로 쓴다.

   2) 재생이 멈춰도(stall) 아무도 안 알려준다.
      ended 이벤트만 기다리면 디코딩이 막힌 순간 영원히 끝나지 않는다.
      currentTime 이 안 늘어나는지 감시하다가 되살리고, 그래도 안 되면 거기까지만 쓴다.

   3) AudioContext.resume() 이 영영 안 끝날 수 있다.
      (사용자 제스처가 소모된 뒤 호출하면 모바일에서 보류 상태로 남는다)
      기다리다 지치면 그냥 시작한다. */
function record(url, meta, p, factor, { onProgress, onPause, onStall, signal } = {}) {
  return loadVideo(url).then(v => new Promise((res, rej) => {
    v.muted = false;
    /* 범위를 벗어난 값을 넣으면 예외가 나면서 배속이 1 로 되돌아간다 — 반드시 막는다 */
    try { v.playbackRate = Math.min(Math.max(p.speed, 0.5), MAX_SPEED); }
    catch { v.playbackRate = 1; }

    const canvas = document.createElement('canvas');
    canvas.width = p.w; canvas.height = p.h;
    const ctx = canvas.getContext('2d', { alpha: false });

    /* captureStream(0) + requestFrame() 이면 "그린 순간"에만 프레임이 들어간다.
       (지원하지 않는 브라우저는 기존처럼 브라우저가 알아서 30fps 로 퍼 간다) */
    const probeStream = canvas.captureStream(0);
    const useRequestFrame = typeof probeStream.getVideoTracks()[0]?.requestFrame === 'function';
    const stream = useRequestFrame ? probeStream : canvas.captureStream(FPS);
    if (!useRequestFrame) probeStream.getTracks().forEach(t => t.stop());
    const videoTrack = stream.getVideoTracks()[0];

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

    let timer = null, done = false, frames = 0, recStarted = false;
    let lastTime = -1, lastMoveAt = performance.now(), recovering = false;

    let settled = false;   // res/rej 는 한 번만. (취소와 onstop 이 겹쳐 두 번 들어올 수 있다)
    const cleanup = () => {
      done = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      signal?.removeEventListener('abort', onAbort);
      try { v.pause(); } catch {}
      // close() 는 Promise 라서 try/catch 로는 안 잡힌다 (이미 닫혔으면 거부된다)
      if (ac && ac.state !== 'closed') { try { ac.close().catch(() => {}); } catch {} }
      ac = null;
    };

    /* 녹화를 끝낸다. reason 은 결과에 함께 돌려줘 호출자가 사용자에게 알릴 수 있게 한다. */
    let endReason = 'ended';
    const finish = reason => {
      if (done) return;
      endReason = reason;
      done = true;                       // tick 이 더 돌지 않게 먼저 막는다
      clearInterval(timer);
      try { v.pause(); } catch {}
      try {
        if (rec.state !== 'inactive') rec.stop();
        else onRecordingStopped();
      } catch { onRecordingStopped(); }
    };

    const onRecordingStopped = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (frames < 2) {
        return rej(new Error('화면이 가려져 있어 영상이 녹화되지 않았어요. 이 화면을 켠 채 다시 시도해 주세요.'));
      }
      res({
        blob: new Blob(chunks, { type: mime.split(';')[0] }),
        mime, frames, reason: endReason,
        coveredSeconds: Math.max(0, lastTime),
      });
    };

    /* 주 시계: 타이머로 그린다 (창이 덮여도 계속 돈다) */
    const tick = () => {
      if (done) return;
      if (document.hidden || v.paused) return;   // 가려졌을 때는 onVisibility 가 멈춰 둔 상태

      /* 재생이 실제로 시작된 뒤에 녹화를 건다.
         먼저 걸면 재생이 시작되기까지 1초 안팎이 "정지 화면"으로 결과물 맨 앞에 붙고,
         그만큼 영상이 소리보다 길어져 끝에서 어긋난다. */
      if (!recStarted) {
        if (!(v.currentTime > 0)) return;
        ctx.drawImage(v, 0, 0, p.w, p.h);        // 첫 프레임을 캔버스에 올려 두고
        rec.start(1000);                          // 그 다음 녹화를 시작한다
        recStarted = true;
        lastMoveAt = performance.now();
      }

      ctx.drawImage(v, 0, 0, p.w, p.h);
      if (useRequestFrame) { try { videoTrack.requestFrame(); } catch {} }
      frames++;

      const t = v.currentTime;
      if (t > lastTime + 0.001) {
        lastTime = t;
        lastMoveAt = performance.now();
        if (recovering) {
          recovering = false;
          try { rec.state === 'paused' && rec.resume(); } catch {}   // 되살아났으니 녹화 재개
          onStall?.(false);
        }
        onProgress?.(Math.min(1, t / meta.dur));
      }

      const stuckMs = performance.now() - lastMoveAt;
      if (stuckMs < FREEZE_PAUSE_MS) return;

      /* 재생이 멈춰 있는 동안에는 녹화를 세워 둔다.
         안 그러면 되살아날 때까지 정지 화면이 결과물에 그대로 쌓인다. */
      try { rec.state === 'recording' && rec.pause(); } catch {}

      // 끝까지 다 재생했는데 ended 이벤트가 안 온 경우 (간혹 있다)
      if (meta.dur - t < 0.3) return finish('ended');

      if (stuckMs < STALL_WARN_MS) return;
      // 재생이 멈춤 — 되살려 보고, 그래도 안 되면 여기까지만 쓴다
      if (stuckMs > STALL_GIVEUP_MS) return finish('stalled');
      if (!recovering) { recovering = true; onStall?.(true); }
      v.play().catch(() => {});
    };

    // 화면에서 벗어나면 멈추고, 돌아오면 이어서 한다
    function onVisibility() {
      if (done) return;
      if (document.hidden) {
        v.pause();
        try { rec.state === 'recording' && rec.pause(); } catch {}
        onPause?.(true);
      } else {
        try { rec.state === 'paused' && rec.resume(); } catch {}
        v.play().catch(() => {});
        lastMoveAt = performance.now();   // 멈춰 있던 시간은 stall 로 세지 않는다
        onPause?.(false);
      }
    }
    document.addEventListener('visibilitychange', onVisibility);

    function onAbort() {
      if (settled) return;
      settled = true;
      cleanup();
      try { rec.state !== 'inactive' && rec.stop(); } catch {}
      rej(new DOMException('취소했어요', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort);

    rec.onstop = onRecordingStopped;
    rec.onerror = () => { if (settled) return; settled = true; cleanup(); rej(new Error('녹화 중 오류가 났어요')); };
    v.onended = () => finish('ended');
    v.onerror = () => { if (settled) return; settled = true; cleanup(); rej(new Error('재생 중 오류가 났어요')); };

    const start = () => {
      if (done) return;
      lastMoveAt = performance.now();
      timer = setInterval(tick, Math.round(1000 / FPS));   // 첫 틱에서 재생을 확인하고 녹화를 건다
      v.play().catch(e => { if (settled) return; settled = true; cleanup(); rej(e); });
    };
    const startWhenVisible = () => {
      if (signal?.aborted) return onAbort();
      if (!document.hidden) return start();
      // 화면이 가려진 채로 시작하면 캔버스가 갱신되지 않는다. 돌아올 때까지 기다린다.
      onPause?.(true);
      const wait = () => {
        if (document.hidden || done) return;
        document.removeEventListener('visibilitychange', wait);
        onPause?.(false);
        start();
      };
      document.addEventListener('visibilitychange', wait);
    };

    /* resume() 이 영영 안 끝나는 기기가 있어서 기다리는 시간을 제한한다 */
    if (ac) {
      Promise.race([ac.resume().catch(() => {}), new Promise(r => setTimeout(r, 1500))])
        .then(startWhenVisible, startWhenVisible);
    } else {
      startWhenVisible();
    }
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

/* 전체 과정: 목표 용량에 맞을 때까지 다시 녹화 → 마지막에 다시 포장.

   재시도는 비싸다 — 한 번에 영상 길이만큼 통째로 다시 걸린다.
   그래서 (1) 조금 넘친 정도는 그냥 받아들이고, (2) 긴 영상은 재시도 횟수를 줄이고,
   (3) 비트레이트를 낮춰도 소용없는 상황이면 아예 재시도하지 않는다. */
export async function compress(file, meta, opts, { onProgress, onAttempt, onPause, onMeasure, onStall, signal } = {}) {
  /* 배속을 쓰면 먼저 실제로 낼 수 있는 속도를 재고, 그 값으로 계획을 세운다.
     그래야 목표 용량을 한 번에 맞추고, 남은 시간도 맞게 보여줄 수 있다. */
  let p = plan(meta, opts);
  if (opts.speed > 1) {
    onMeasure?.();
    const realSpeed = await measureSpeed(file, p.speed);
    p = plan(meta, { ...opts, realSpeed });
  }

  // 결과 길이가 2분을 넘으면 재시도 한 번까지만 (그 이상은 사용자가 너무 오래 기다린다)
  const maxAttempts = p.outDur > 120 ? 2 : 4;
  const ACCEPT = 1.02;          // 목표보다 2% 이내로 넘친 건 그냥 통과시킨다

  const url = URL.createObjectURL(file);
  try {
    let factor = 1, out, attempt, stopped = '';
    for (attempt = 1; attempt <= maxAttempts; attempt++) {
      onAttempt?.(attempt, maxAttempts);
      out = await record(url, meta, p, factor, { onProgress, onPause, onStall, signal });

      if (out.blob.size <= p.limit * ACCEPT) break;

      /* 요청한 비트레이트보다 실제로 더 낮게 나왔다면, 더 낮춰 달라고 해도 소용없다.
         (인코더가 이미 자기 하한에 걸려 있다) 괜히 한 번 더 돌리지 않는다. */
      const achieved = out.coveredSeconds > 0 ? out.blob.size * 8 / out.coveredSeconds : Infinity;
      const asked = Math.max(80000, p.videoBps * factor) + p.audioBps;
      if (achieved < asked * 0.9) { stopped = 'encoder-floor'; break; }
      if (attempt === maxAttempts) { stopped = 'max-attempts'; break; }

      factor *= (p.limit / out.blob.size) * 0.9;
    }

    const packed = await repackage(out.blob);
    // 실제로 나온 배속 (영상 해독이 못 따라가면 설정값보다 낮다)
    const outSeconds = packed.info?.tracks?.reduce((s, t) => Math.max(s, t.seconds), 0) || 0;
    const actualSpeed = outSeconds > 0 ? meta.dur / outSeconds : p.effective;

    const warnings = [...(packed.warnings || [])];
    if (out.reason === 'stalled') {
      // 거의 아무것도 못 읽었으면 쓸 수 없는 결과다 — 결과인 척 내놓지 않는다
      if (out.coveredSeconds < 1) {
        throw new Error('이 영상을 브라우저가 읽지 못해요 (재생이 바로 멈춤). 다른 파일로 시도하거나, 휴대폰 갤러리에서 한 번 저장한 뒤 올려 주세요.');
      }
      warnings.push(`영상을 읽다가 ${out.coveredSeconds.toFixed(0)}초 지점에서 멈춰서, 거기까지만 저장했어요. 원본 파일에 문제가 있을 수 있어요.`);
    }
    if (stopped === 'encoder-floor' && packed.blob.size > p.limit) {
      warnings.push('이 기기에서는 화질을 더 낮출 수 없어서 목표 용량까지 못 줄였어요. 배속을 올리거나 「소리 빼기」를 써보세요.');
    }
    /* 중간에 화면이 멈춘 구간(캔버스가 갱신되지 않은 구간)이 있으면 알려 준다 */
    const vt = packed.info?.tracks?.find(t => t.type === 'video');
    if (vt?.maxGapSeconds > 2) {
      warnings.push(`영상 ${vt.maxGapAtSeconds.toFixed(0)}초 부근에서 화면이 ${vt.maxGapSeconds.toFixed(1)}초 동안 멈춰 있어요. 압축하는 동안 이 화면을 계속 켜 두세요.`);
    }

    return {
      blob: packed.blob, plan: p, attempts: attempt, actualSpeed, reason: out.reason,
      remuxed: packed.remuxed, info: packed.info, warnings,
      withinTarget: packed.blob.size <= p.limit * ACCEPT,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
