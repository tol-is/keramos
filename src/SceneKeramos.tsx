import { useEffect, useRef } from "react";
import { useWindowSize } from "./useWindowSize";

const NP = 48; // profile stations, base → rim
const S = 64; // view azimuth segments
const K = 48; // material azimuth slots per station

const CAM_PITCH = -0.46; // negative = looking down into the mouth
const OMEGA0 = 4.2; // wheel speed rad/s
const DRAG_SLOW = 0.35; // fraction of speed lost under full finger pressure

const FR_FRAC = 0.17; // fingertip radius × R0
const CLAY_RATE = 9.0; // max radial yield × R0 per second
const WALL0 = 0.17; // starting wall thickness × R0
const WALL_MIN = 0.05; // thinnest wall a pull can draw × R0
const PULL_K = 0.0013; // wall thinning per px of upward stroke
const DIFF_AZ = 3.2; // azimuthal diffusion /s
const DIFF_V = 0.35; // vertical cohesion /s — stronger un-molds carved features
const DR_MAX = 0.34; // per-slot deviation clamp × R0
const R_MIN = 0.13; // minimum pinch radius × R0
const ECC = 0.008; // idle eccentricity × R0

const SLUMP_T = 1.1; // collapse s
const PICK_R = 90; // px — how far from the wall the finger still reaches

export default function SceneKeramos() {
  const { w: W, h: H } = useWindowSize();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const prevTRef = useRef(0);

  const mxRef = useRef(-9999);
  const myRef = useRef(-9999);
  const hasMouseRef = useRef(false);
  const downRef = useRef(false); // pointer held — the hand is ON the clay
  const slumpReqRef = useRef(false);

  useEffect(() => {
    const onButton = (t: EventTarget | null) =>
      t instanceof Element && t.closest("button, a") !== null;
    const onMove = (e: MouseEvent) => {
      mxRef.current = e.clientX;
      myRef.current = e.clientY;
      hasMouseRef.current = true;
    };
    const onLeave = () => {
      hasMouseRef.current = false;
    };
    const onTouch = (e: TouchEvent) => {
      if (onButton(e.target)) return;
      const t = e.touches[0];
      if (!t) return;
      mxRef.current = t.clientX;
      myRef.current = t.clientY;
      hasMouseRef.current = true;
    };
    const onTouchEnd = () => {
      hasMouseRef.current = false;
      downRef.current = false;
    };
    const onDown = (e: PointerEvent) => {
      if (onButton(e.target)) return;
      mxRef.current = e.clientX;
      myRef.current = e.clientY;
      hasMouseRef.current = true;
      downRef.current = true;
    };
    const onUp = () => {
      downRef.current = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseleave", onLeave);
    window.addEventListener("touchstart", onTouch, { passive: true });
    window.addEventListener("touchmove", onTouch, { passive: true });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("touchstart", onTouch);
      window.removeEventListener("touchmove", onTouch);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
    };
  }, []);

  useEffect(() => {
    if (!W || !H) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // opaque backing store composites faster than a transparent canvas
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const R0 = Math.min(W, H) * 0.23;
    const hMax = Math.min(W, H) * 0.64;
    const h0 = R0 * 0.95;
    const RW = R0 * 1.6; // wheel head radius
    const FR = R0 * FR_FRAC;
    const cx = W / 2;
    const cy = H * 0.6;
    const FOV = Math.min(W, H) * 0.85;
    const cosP = Math.cos(CAM_PITCH);
    const sinP = Math.sin(CAM_PITCH);
    const dAK = (Math.PI * 2) / K;

    // ── clay state ──
    const lump = new Float32Array(NP);
    for (let i = 0; i < NP; i++) {
      const u = i / (NP - 1);
      lump[i] = R0 * (0.55 + 0.45 * Math.sqrt(Math.max(0, 1 - u * u)));
    }
    const rBase = new Float32Array(lump);
    const dr = new Float32Array(NP * K);
    const fresh = new Float32Array(NP * K); // just-worked clay, lights up
    let h = h0;
    // each band conserves its shell (radius × wall × length): thinning a
    // band lengthens it in place, so the base never moves
    const dy0 = h0 / (NP - 1);
    const wallTs = new Float32Array(NP).fill(R0 * WALL0);
    const dyCur = new Float32Array(NP).fill(dy0);
    const yCum = new Float32Array(NP);
    for (let i = 1; i < NP; i++) yCum[i] = yCum[i - 1] + dy0;
    let clayPhase = 0;
    let wheelPhase = 0;
    let omega = OMEGA0;
    let yLook = h0 * 0.42;

    // finger / feel
    let contact = 0; // eased contact amount → glow, wheel drag
    let fingerRow = -999; // station currently under the finger, -999 if none
    let sprayCd = 0; // gouge-spray cooldown
    let prevMy = -9999; // last frame's cursor y, for the pull stroke
    // 1 outside the wall, -1 inside the bore; sticks while buried so an
    // outward push from inside can't flip into a dent at the wall
    let handSide = 0;
    const glowRow = new Float32Array(NP);

    // button-triggered slump back to the lump
    let slumpT = 0;
    const slumpFrom = new Float32Array(NP);

    // clay flecks thrown off a hard gouge or the slump
    const FLECKS = 26;
    const fx = new Float32Array(FLECKS), fy = new Float32Array(FLECKS);
    const fvx = new Float32Array(FLECKS), fvy = new Float32Array(FLECKS);
    const fl = new Float32Array(FLECKS);
    let fleckN = 0;

    // ── render buffers ──
    const NF_MAX = (NP * 2 + 4) * S + 8;
    const qx0 = new Float32Array(NF_MAX), qy0 = new Float32Array(NF_MAX);
    const qx1 = new Float32Array(NF_MAX), qy1 = new Float32Array(NF_MAX);
    const qx2 = new Float32Array(NF_MAX), qy2 = new Float32Array(NF_MAX);
    const qx3 = new Float32Array(NF_MAX), qy3 = new Float32Array(NF_MAX);
    const qsx0 = new Float32Array(NF_MAX), qsy0 = new Float32Array(NF_MAX);
    const qsx1 = new Float32Array(NF_MAX), qsy1 = new Float32Array(NF_MAX);
    const qdepth = new Float32Array(NF_MAX);
    const qalpha = new Float32Array(NF_MAX);
    const qwidth = new Float32Array(NF_MAX);
    const qkey = new Float64Array(NF_MAX);
    let nq = 0;

    // quantized white strokes — avoids building an rgba string per quad
    const INK: string[] = new Array(256);
    for (let i = 0; i < 256; i++) {
      INK[i] = `rgba(255,255,255,${(i / 255).toFixed(3)})`;
    }
    const ink = (a: number) => INK[a <= 0 ? 0 : a >= 1 ? 255 : (a * 255) | 0];

    // contact-arc scratch rows
    const NAZ = 64;
    const rpx = new Float64Array(NAZ), rpy = new Float64Array(NAZ);
    const gpx = new Float64Array(NAZ), gpy = new Float64Array(NAZ);

    const cosA = new Float64Array(S + 1), sinA = new Float64Array(S + 1);
    for (let j = 0; j <= S; j++) {
      const a = (j / S) * Math.PI * 2;
      cosA[j] = Math.cos(a);
      sinA[j] = Math.sin(a);
    }

    // two vertex rows (camera + screen) reused while sweeping bands
    const mk = () => ({
      cxr: new Float64Array(S + 1),
      cyr: new Float64Array(S + 1),
      czr: new Float64Array(S + 1),
      sxr: new Float64Array(S + 1),
      syr: new Float64Array(S + 1),
    });
    const rowA = mk(), rowB = mk(), rimRow = mk();
    type Row = ReturnType<typeof mk>;

    const fillRow = (row: Row, y: number, radiusOf: (j: number) => number) => {
      const yc = y - yLook;
      for (let j = 0; j <= S; j++) {
        const r = radiusOf(j === S ? 0 : j);
        const x = r * cosA[j];
        const z = r * sinA[j];
        const y2 = yc * cosP - z * sinP;
        const z2 = yc * sinP + z * cosP;
        const persp = FOV / (FOV + z2);
        row.cxr[j] = x;
        row.cyr[j] = y2;
        row.czr[j] = z2;
        row.sxr[j] = cx + x * persp;
        row.syr[j] = cy - y2 * persp;
      }
    };

    // quad from rows lo→hi at segment j; strokes the hi row's ring edge.
    // flip=true reverses the winding (inner wall / upward-facing bands).
    const band = (
      lo: Row, hi: Row, j: number, flip: boolean, alpha: number, width: number,
    ) => {
      const j1 = j + 1;
      let ax, ay, az, bx, by, bz, cxx, cyy, czz, dz;
      let asx, asy, bsx, bsy, csx, csy, dsx, dsy;
      if (!flip) {
        // lo(j) → hi(j) → hi(j1) → lo(j1)
        ax = lo.cxr[j]; ay = lo.cyr[j]; az = lo.czr[j]; asx = lo.sxr[j]; asy = lo.syr[j];
        bx = hi.cxr[j]; by = hi.cyr[j]; bz = hi.czr[j]; bsx = hi.sxr[j]; bsy = hi.syr[j];
        cxx = hi.cxr[j1]; cyy = hi.cyr[j1]; czz = hi.czr[j1]; csx = hi.sxr[j1]; csy = hi.syr[j1];
        dz = lo.czr[j1]; dsx = lo.sxr[j1]; dsy = lo.syr[j1];
      } else {
        ax = lo.cxr[j]; ay = lo.cyr[j]; az = lo.czr[j]; asx = lo.sxr[j]; asy = lo.syr[j];
        bx = lo.cxr[j1]; by = lo.cyr[j1]; bz = lo.czr[j1]; bsx = lo.sxr[j1]; bsy = lo.syr[j1];
        cxx = hi.cxr[j1]; cyy = hi.cyr[j1]; czz = hi.czr[j1]; csx = hi.sxr[j1]; csy = hi.syr[j1];
        dz = hi.czr[j]; dsx = hi.sxr[j]; dsy = hi.syr[j];
      }
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cxx - ax, vy = cyy - ay, vz = czz - az;
      const nz = ux * vy - uy * vx;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const facing = -nz / len;
      if (facing < 0.02) return;
      const i = nq++;
      qx0[i] = asx; qy0[i] = asy;
      qx1[i] = bsx; qy1[i] = bsy;
      qx2[i] = csx; qy2[i] = csy;
      qx3[i] = dsx; qy3[i] = dsy;
      // ring edge to stroke = the hi row segment
      qsx0[i] = hi.sxr[j]; qsy0[i] = hi.syr[j];
      qsx1[i] = hi.sxr[j1]; qsy1[i] = hi.syr[j1];
      qdepth[i] = (az + bz + czz + dz) * 0.25;
      let a2 = alpha * (0.35 + 0.65 * facing);
      if (a2 > 1) a2 = 1;
      qalpha[i] = a2;
      qwidth[i] = width;
    };

    // sample the per-slot deviation at material azimuth index (fractional)
    const drAt = (i: number, mi: number) => {
      let m = mi % K;
      if (m < 0) m += K;
      const k0 = m | 0;
      const f = m - k0;
      const k1 = k0 + 1 === K ? 0 : k0 + 1;
      const base = i * K;
      return dr[base + k0] * (1 - f) + dr[base + k1] * f;
    };
    const freshAt = (i: number, mi: number) => {
      let m = mi % K;
      if (m < 0) m += K;
      const k0 = m | 0;
      const f = m - k0;
      const k1 = k0 + 1 === K ? 0 : k0 + 1;
      const base = i * K;
      return fresh[base + k0] * (1 - f) + fresh[base + k1] * f;
    };

    // eased drawn radius at station i, view segment j
    const shift = { v: 0 }; // material index offset for the current frame
    const drawR = (i: number, j: number) => {
      const mi = (j * K) / S + shift.v;
      const u = i / (NP - 1);
      const am = mi * dAK;
      const ecc =
        R0 * ECC * (0.4 + 0.6 * u) *
        (Math.sin(2 * am + i * 0.9) + 0.6 * Math.sin(3 * am - i * 0.5 + 1.7));
      let r = rBase[i] + drAt(i, mi) + ecc;
      if (r < R0 * 0.05) r = R0 * 0.05;
      return r;
    };

    let frame = 0;
    let fingerSX = -9999, fingerSY = -9999, fingerOn = 0;

    const loop = (now: number) => {
      const dt = Math.min((now - prevTRef.current) / 1000, 0.05);
      prevTRef.current = now;
      frame++;

      // ── wheel ──
      const dragTarget = OMEGA0 * (1 - DRAG_SLOW * Math.min(1, contact * 26));
      omega += (dragTarget - omega) * Math.min(1, dt * 4);
      wheelPhase += omega * dt;
      clayPhase += omega * dt;
      contact -= contact * Math.min(1, dt * 7);
      sprayCd -= dt;
      for (let i = 0; i < NP; i++) glowRow[i] -= glowRow[i] * Math.min(1, dt * 5);
      const yLookT = Math.min(Math.max(h * 0.42, R0 * 0.4), hMax * 0.45);
      yLook += (yLookT - yLook) * Math.min(1, dt * 2);

      // ── the fingertip ──
      const throwing = slumpT <= 0;
      let pressed = 0;
      fingerRow = -999;
      if (throwing && hasMouseRef.current) {
        const mx = mxRef.current, my = myRef.current;
        // nearest station by the screen y of its silhouette
        let iF = -1, bd = PICK_R;
        let perspF = 1;
        for (let i = 0; i < NP; i++) {
          const y = yCum[i];
          const yc = y - yLook;
          const z2 = yc * sinP;
          const persp = FOV / (FOV + z2);
          const sy = cy - yc * cosP * persp;
          const d = Math.abs(my - sy);
          if (d < bd) {
            bd = d;
            iF = i;
            perspF = persp;
          }
        }
        if (iF >= 0) {
          fingerRow = iF;
          const rc = Math.abs(mx - cx) / perspF; // cursor's implied radius
          const side = mx >= cx ? 0 : Math.PI; // which silhouette it touches
          const miC = (side - clayPhase) / dAK; // material slot under the finger
          const maxStep = CLAY_RATE * R0 * dt;
          const rHere = rBase[iF] + drAt(iF, miC);
          const riHere = rHere - wallTs[iF];
          // stickiness only holds while pressed; hover reclassifies freely
          if (!downRef.current) handSide = rc > (rHere + riHere) / 2 ? 1 : -1;
          else if (handSide <= 0 && rc > rHere + FR * 1.5) handSide = 1;
          else if (handSide >= 0 && rc < riHere - FR * 0.4) handSide = -1;
          else if (handSide === 0) handSide = rc > (rHere + riHere) / 2 ? 1 : -1;
          // fingertip reach in stations depends on current pot height
          const dyS = h / (NP - 1);
          const diR = Math.max(1, Math.min(5, Math.round((FR * 0.8) / dyS)));
          const sigI = diR / 2;
          let gouge = 0;
          // hover aims, drag shapes
          if (downRef.current)
          for (let di = -diR; di <= diR; di++) {
            const i = iF + di;
            if (i < 0 || i >= NP) continue;
            const wI = Math.exp(-(di * di) / (2 * sigI * sigI));
            for (let dk = -4; dk <= 4; dk++) {
              let k = Math.round(miC) + dk;
              k %= K;
              if (k < 0) k += K;
              const wA = Math.exp(-(dk * dk) / 6);
              const idx = i * K + k;
              const r = rBase[i] + dr[idx];
              let want = 0;
              if (handSide >= 0) {
                // outside hand pushes the wall in
                const target = rc - FR;
                if (target < r) want = target - r; // negative
              } else {
                // inside hand opens the wall out; clay clings just beyond
                // contact
                const target = rc + FR + wallTs[i];
                if (target > r) {
                  want = target - r;
                  if (rc > r) want *= 0.6; // adhesion, not pressure
                }
              }
              if (want !== 0) {
                const scaled = want * wI * wA;
                const cap = maxStep * wI * wA;
                let step = scaled;
                if (step > cap) step = cap;
                else if (step < -cap) step = -cap;
                // past 4× the yield rate the clay tears instead of yielding
                if (Math.abs(scaled) > cap * 4) {
                  const excess = scaled - Math.sign(scaled) * cap * 4;
                  gouge += Math.abs(excess);
                  step += excess * 0.5;
                }
                let nd = dr[idx] + step;
                const lim = R0 * DR_MAX;
                if (nd > lim) nd = lim;
                else if (nd < -lim) nd = -lim;
                // the wall can't be pinched through, nor flared off the wheel
                if (rBase[i] + nd < R0 * R_MIN) nd = R0 * R_MIN - rBase[i];
                else if (rBase[i] + nd > RW * 0.96) nd = RW * 0.96 - rBase[i];
                const applied = nd - dr[idx];
                pressed += Math.abs(applied);
                dr[idx] = nd;
                if (applied !== 0) {
                  const f = fresh[idx] + Math.abs(applied) * 0.2 + 0.35;
                  fresh[idx] = f > 1 ? 1 : f;
                }
              }
            }
            glowRow[i] = Math.min(1, glowRow[i] + pressed * 3);
          }
          // the pull: stroke up to thin and lengthen, down to gather thick
          const touching =
            downRef.current && (pressed > 0 || Math.abs(rc - rHere) < FR * 1.8);
          if (touching && prevMy > -9998) {
            let dyC = my - prevMy;
            if (dyC < -25) dyC = -25;
            else if (dyC > 25) dyC = 25;
            // gathering is light-touch: gate on burial depth so a buried,
            // carving finger doesn't undo the pot's height
            if (dyC > 0) {
              const pen =
                handSide >= 0 ? rHere - rc : rc - riHere; // burial depth
              dyC *= Math.max(0, 1 - Math.max(0, pen) / (FR * 0.8));
            }
            // a downward stroke also trues the wall as it comes down
            const calm = dyC > 0 ? Math.min(0.25, dyC * 0.03) : 0;
            for (let di = -diR; di <= diR; di++) {
              const i = iF + di;
              if (i < 0 || i >= NP) continue;
              const wP = Math.exp(-(di * di) / (2 * sigI * sigI));
              let wt = wallTs[i] * Math.exp(dyC * PULL_K * 3 * wP);
              if (wt < R0 * WALL_MIN) wt = R0 * WALL_MIN;
              else if (wt > R0 * WALL0 * 1.25) wt = R0 * WALL0 * 1.25;
              wallTs[i] = wt;
              if (calm > 0) {
                const d = 1 - calm * wP;
                const base = i * K;
                for (let k = 0; k < K; k++) dr[base + k] *= d;
              }
            }
          }
          // clay sprays off a hard gouge
          if (gouge > R0 * 0.35 && sprayCd <= 0) {
            sprayCd = 0.1;
            for (let n = 0; n < 2 && fleckN < FLECKS; n++) {
              const i = fleckN++;
              const dir = mx >= cx ? 1 : -1;
              fx[i] = mx;
              fy[i] = my;
              fvx[i] = dir * (140 + 90 * n) * (0.6 + 0.4 * Math.sin(wheelPhase * 13 + n * 5));
              fvy[i] = -160 - 120 * Math.abs(Math.sin(wheelPhase * 7 + n * 3));
              fl[i] = 1;
            }
          }
          fingerSX = mx;
          fingerSY = my;
          const fTarget = downRef.current
            ? Math.min(1, pressed * 40) + 0.35
            : 0.16; // hover: a faint aiming preview
          fingerOn += (fTarget - fingerOn) * Math.min(1, dt * 10);
        } else {
          fingerOn -= fingerOn * Math.min(1, dt * 6);
          handSide = 0;
        }
        prevMy = my;
      } else {
        fingerOn -= fingerOn * Math.min(1, dt * 6);
        prevMy = -9999;
        handSide = 0;
      }
      contact += pressed * 0.06;

      // ── clay relaxation: the spin trues the wall, clay coheres ──
      {
        const ka = Math.min(0.45, DIFF_AZ * dt);
        // slow creep trues the low-mode asymmetry the laplacian misses
        const creep = 1 - Math.min(0.5, 0.12 * dt);
        for (let i = 0; i < NP; i++) {
          const base = i * K;
          let prev = dr[base + K - 1];
          const first = dr[base];
          let mean = 0;
          for (let k = 0; k < K; k++) {
            const cur = dr[base + k];
            const next = k === K - 1 ? first : dr[base + k + 1];
            const nd = (cur + (prev + next - 2 * cur) * ka) * creep;
            prev = cur;
            dr[base + k] = nd;
            mean += nd;
          }
          mean /= K;
          // fold the ring mean into the true profile
          rBase[i] += mean;
          for (let k = 0; k < K; k++) dr[base + k] -= mean;
        }
        const kv = Math.min(0.4, DIFF_V * dt);
        for (let i = 1; i < NP - 1; i++) {
          rBase[i] += (rBase[i - 1] + rBase[i + 1] - 2 * rBase[i]) * kv;
        }
        // fresh glow decays
        const fdk = 1 - Math.min(0.6, dt * 1.3);
        for (let i = 0; i < NP * K; i++) fresh[i] *= fdk;
        // wall thickness coheres along the profile
        const kw = Math.min(0.3, DIFF_V * dt * 0.8);
        for (let i = 1; i < NP - 1; i++) {
          wallTs[i] += (wallTs[i - 1] + wallTs[i + 1] - 2 * wallTs[i]) * kw;
        }
        // shell conservation: a band necked narrower or pulled thinner
        // lengthens in place; bellied wider or gathered thicker it settles
        const w0 = R0 * WALL0;
        let acc = 0;
        for (let i = 1; i < NP; i++) {
          let ratio = (lump[i] * w0) / Math.max(rBase[i] * wallTs[i], 1);
          if (ratio < 0.4) ratio = 0.4;
          else if (ratio > 6) ratio = 6;
          const dyT = dy0 * Math.pow(ratio, 1.15);
          dyCur[i] += (dyT - dyCur[i]) * Math.min(1, dt * 5);
          acc += dyCur[i];
        }
        if (acc > hMax) {
          const s = hMax / acc;
          for (let i = 1; i < NP; i++) dyCur[i] *= s;
          acc = hMax;
        }
        h = acc;
        yCum[0] = 0;
        for (let i = 1; i < NP; i++) yCum[i] = yCum[i - 1] + dyCur[i];
      }

      // ── reset button: slump back to the lump ──
      if (slumpReqRef.current) {
        slumpReqRef.current = false;
        if (slumpT <= 0) {
          slumpT = SLUMP_T;
          slumpFrom.set(rBase);
          for (let n = 0; n < 10 && fleckN < FLECKS; n++) {
            const i = fleckN++;
            const a = (n / 10) * Math.PI * 2;
            const yTop = h - yLook;
            const persp = FOV / (FOV + yTop * sinP);
            fx[i] = cx + Math.cos(a) * rBase[NP - 1] * persp;
            fy[i] = cy - yTop * cosP * persp;
            fvx[i] = Math.cos(a) * (120 + 60 * Math.sin(n * 3.7));
            fvy[i] = -90 - 70 * Math.abs(Math.sin(n * 2.3));
            fl[i] = 1;
          }
        }
      }
      if (slumpT > 0) {
        slumpT -= dt;
        const p = 1 - Math.max(0, slumpT) / SLUMP_T;
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        for (let i = 0; i < NP; i++) {
          rBase[i] = slumpFrom[i] + (lump[i] - slumpFrom[i]) * e;
        }
        const decay = Math.min(1, dt * 6);
        for (let i = 0; i < NP * K; i++) dr[i] -= dr[i] * decay;
        // the folding wall gathers back thick as the clay comes down
        const gather = Math.min(1, dt * 3);
        for (let i = 0; i < NP; i++) {
          wallTs[i] += (R0 * WALL0 - wallTs[i]) * gather;
        }
        if (slumpT <= 0) {
          // snap only the sub-pixel residuals; height keeps easing via
          // shell conservation so the clay settles without a jump
          rBase.set(lump);
          dr.fill(0);
          fresh.fill(0);
          wallTs.fill(R0 * WALL0);
        }
      }

      // ── paint ──
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);

      // wheel head: scored disc with slip streaks carrying the spin; rings
      // are projected point-by-point so the pot sits dead centre
      {
        const ringStroke = (r: number, a0: number, a1: number, N2: number) => {
          ctx.beginPath();
          for (let s2 = 0; s2 <= N2; s2++) {
            const a = a0 + ((a1 - a0) * s2) / N2;
            const wx = r * Math.cos(a);
            const wz = r * Math.sin(a);
            const yc = 0 - yLook;
            const y2 = yc * cosP - wz * sinP;
            const z2 = yc * sinP + wz * cosP;
            const pr = FOV / (FOV + z2);
            if (s2 === 0) ctx.moveTo(cx + wx * pr, cy - y2 * pr);
            else ctx.lineTo(cx + wx * pr, cy - y2 * pr);
          }
          ctx.stroke();
        };
        ctx.lineWidth = 1.3;
        ctx.strokeStyle = ink(0.38);
        ringStroke(RW, 0, Math.PI * 2, 72);
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = ink(0.13);
        for (const f of [0.42, 0.66, 0.86]) {
          ringStroke(RW * f, 0, Math.PI * 2, 48);
        }
        ctx.lineWidth = 1.7;
        ctx.lineCap = "round";
        for (let n = 0; n < 7; n++) {
          const rr = RW * (0.3 + 0.62 * ((n * 0.383) % 1));
          const a0 = wheelPhase + n * 2.399; // golden-angle spread
          const len = 0.22 + 0.34 * ((n * 0.611) % 1);
          const al = 0.08 + 0.18 * (0.5 + 0.5 * Math.sin(wheelPhase * 0.6 + n * 1.7));
          ctx.strokeStyle = ink(al);
          ringStroke(rr, a0, a0 + len, 7);
        }
      }

      // ── the pot: build bands, painter-sort, fill --bg + stroke rings ──
      nq = 0;
      shift.v = (-clayPhase * K) / (Math.PI * 2);
      const yOf = (i: number) => yCum[i];

      // outer wall
      fillRow(rowA, yOf(0), (j) => drawR(0, j));
      for (let i = 1; i < NP; i++) {
        const grainI = i;
        fillRow(rowB, yOf(i), (j) => drawR(grainI, j));
        const u = i / (NP - 1);
        // line weight scales with local ring spacing so dense bands at the
        // foot don't blob
        const wLine = Math.min(1.9, 0.8 + (dyCur[i] / dy0) * 0.55);
        for (let j = 0; j < S; j++) {
          const mi = (j * K) / S + shift.v;
          const am = mi * dAK;
          const g = 0.5 + 0.5 * Math.sin(am * 7 + i * 1.3) * Math.sin(am * 3.7 - i * 0.8);
          const fr = freshAt(i, mi);
          const alpha =
            0.3 + 0.12 * u + g * 0.18 + glowRow[i] * 0.25 + fr * 0.5;
          band(rowA, rowB, j, false, alpha, wLine + glowRow[i] * 0.3 + fr * 0.6);
        }
        const tmp = rowA.cxr;
        // swap rows A↔B
        rowA.cxr = rowB.cxr; rowB.cxr = tmp;
        const t2 = rowA.cyr; rowA.cyr = rowB.cyr; rowB.cyr = t2;
        const t3 = rowA.czr; rowA.czr = rowB.czr; rowB.czr = t3;
        const t4 = rowA.sxr; rowA.sxr = rowB.sxr; rowB.sxr = t4;
        const t5 = rowA.syr; rowA.syr = rowB.syr; rowB.syr = t5;
      }
      // keep the outer rim row for the rim band
      rimRow.cxr.set(rowA.cxr); rimRow.cyr.set(rowA.cyr); rimRow.czr.set(rowA.czr);
      rimRow.sxr.set(rowA.sxr); rimRow.syr.set(rowA.syr);

      // rim: outer rim ring → inner rim ring (faces up)
      fillRow(rowB, yOf(NP - 1), (j) => Math.max(drawR(NP - 1, j) - wallTs[NP - 1], R0 * 0.06));
      for (let j = 0; j < S; j++) band(rowB, rimRow, j, true, 0.92, 2.3);

      // inner wall down to the bore floor
      const baseT = Math.max(R0 * 0.16, h * 0.1);
      let iFloor = 1;
      while (iFloor < NP - 2 && yCum[iFloor] < baseT) iFloor++;
      // rowB currently = inner rim (station NP-1)
      for (let i = NP - 2; i >= iFloor; i--) {
        const gi = i;
        fillRow(rowA, yOf(i), (j) => Math.max(drawR(gi, j) - wallTs[gi], R0 * 0.06));
        for (let j = 0; j < S; j++) band(rowA, rowB, j, true, 0.28, 1.2);
        const tmp = rowB.cxr; rowB.cxr = rowA.cxr; rowA.cxr = tmp;
        const t2 = rowB.cyr; rowB.cyr = rowA.cyr; rowA.cyr = t2;
        const t3 = rowB.czr; rowB.czr = rowA.czr; rowA.czr = t3;
        const t4 = rowB.sxr; rowB.sxr = rowA.sxr; rowA.sxr = t4;
        const t5 = rowB.syr; rowB.syr = rowA.syr; rowA.syr = t5;
      }
      // bore floor: centre ring → floor ring (faces up)
      fillRow(rowA, yOf(iFloor), () => R0 * 0.05);
      for (let j = 0; j < S; j++) band(rowA, rowB, j, true, 0.22, 1);

      // sort far → near, fill opaque, stroke ring edges
      {
        // pack (quantized depth, index) into one number so the typed-array
        // sort runs its fast numeric path instead of a JS comparator
        for (let i = 0; i < nq; i++) {
          qkey[i] = (((4096 - qdepth[i]) * 512) | 0) * 8192 + i;
        }
        const keys = qkey.subarray(0, nq);
        keys.sort();
        ctx.fillStyle = "#000";
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        let lastInk = "";
        let lastW = -1;
        for (let k2 = 0; k2 < nq; k2++) {
          const i = (keys[k2] % 8192) | 0;
          ctx.beginPath();
          ctx.moveTo(qx0[i], qy0[i]);
          ctx.lineTo(qx1[i], qy1[i]);
          ctx.lineTo(qx2[i], qy2[i]);
          ctx.lineTo(qx3[i], qy3[i]);
          ctx.closePath();
          ctx.fill();
          const a = qalpha[i];
          if (a < 0.02) continue; // invisible stroke on black
          const st = ink(a);
          if (st !== lastInk) {
            ctx.strokeStyle = st;
            lastInk = st;
          }
          const w = ((qwidth[i] * 8 + 0.5) | 0) * 0.125;
          if (w !== lastW) {
            ctx.lineWidth = w;
            lastW = w;
          }
          ctx.beginPath();
          ctx.moveTo(qsx0[i], qsy0[i]);
          ctx.lineTo(qsx1[i], qsy1[i]);
          ctx.stroke();
        }
      }

      // contact arc at the nearest point to the cursor, plus a dashed
      // ghost offset the way the clay is about to move
      if (fingerOn > 0.05 && fingerRow >= 0 && slumpT <= 0) {
        const iC = fingerRow;
        const yc = yOf(iC) - yLook;
        const ghostDir = handSide >= 0 ? -1 : 1;
        const ghostOff = (7 + 7 * Math.min(1, fingerOn)) * ghostDir;
        let bestJ = 0;
        let bestD = 1e18;
        for (let j2 = 0; j2 < NAZ; j2++) {
          const a = (j2 / NAZ) * Math.PI * 2;
          const r = rBase[iC] + drAt(iC, a / dAK + shift.v);
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          const proj = (rr: number, out: Float64Array, out2: Float64Array) => {
            const z = rr * sa;
            const y2 = yc * cosP - z * sinP;
            const z2 = yc * sinP + z * cosP;
            const pr = FOV / (FOV + z2);
            out[j2] = cx + rr * ca * pr;
            out2[j2] = cy - y2 * pr;
          };
          proj(r, rpx, rpy);
          proj(r + ghostOff, gpx, gpy);
          const dd = (rpx[j2] - fingerSX) ** 2 + (rpy[j2] - fingerSY) ** 2;
          if (dd < bestD) {
            bestD = dd;
            bestJ = j2;
          }
        }
        const ARC = 8;
        const on = Math.min(1, fingerOn);
        ctx.lineCap = "round";
        for (let s2 = -ARC; s2 < ARC; s2++) {
          const j0 = (bestJ + s2 + NAZ) % NAZ;
          const j1 = (j0 + 1) % NAZ;
          const tip = 1 - Math.abs(s2 + 0.5) / ARC;
          // the contact itself
          ctx.strokeStyle = ink((0.3 + 0.6 * on) * tip);
          ctx.lineWidth = 1.4 + 1.2 * tip * on;
          ctx.beginPath();
          ctx.moveTo(rpx[j0], rpy[j0]);
          ctx.lineTo(rpx[j1], rpy[j1]);
          ctx.stroke();
          // where the clay is headed
          if ((s2 & 1) === 0) {
            ctx.strokeStyle = ink(0.35 * on * tip);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(gpx[j0], gpy[j0]);
            ctx.lineTo(gpx[j1], gpy[j1]);
            ctx.stroke();
          }
        }
      }

      // clay flecks
      for (let i = 0; i < fleckN; i++) {
        fl[i] -= dt * 1.2;
        if (fl[i] <= 0) {
          fleckN--;
          fx[i] = fx[fleckN]; fy[i] = fy[fleckN];
          fvx[i] = fvx[fleckN]; fvy[i] = fvy[fleckN];
          fl[i] = fl[fleckN];
          i--;
          continue;
        }
        fvy[i] += 900 * dt;
        fx[i] += fvx[i] * dt;
        fy[i] += fvy[i] * dt;
        ctx.strokeStyle = ink(0.7 * fl[i]);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(fx[i], fy[i]);
        ctx.lineTo(fx[i] - fvx[i] * 0.028, fy[i] - fvy[i] * 0.028);
        ctx.stroke();
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame((t0) => {
      prevTRef.current = t0;
      rafRef.current = requestAnimationFrame(loop);
    });
    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [W, H]);

  if (!W || !H) return null;

  return (
    <>
      <canvas
        aria-hidden="true"
        ref={canvasRef}
        style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 1 }}
      />
      <button
        type="button"
        className="reset"
        onClick={() => {
          slumpReqRef.current = true;
        }}
      >
        RESET
      </button>
      <a className="corner left" href="https://tol.is" target="_blank" rel="noopener">
        TOL.IS
      </a>
      <a
        className="corner right"
        href="https://github.com/tol-is/keramos"
        target="_blank"
        rel="noopener"
      >
        GITHUB
      </a>
    </>
  );
}
