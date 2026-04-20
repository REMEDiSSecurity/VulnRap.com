import { useEffect, useRef, useCallback } from "react";

interface BugState {
  id: number;
  pathIndex: number;
  progress: number;
  speed: number;
  opacity: number;
  size: number;
  wobble: number;
  wobbleSpeed: number;
  flipX: boolean;
}

interface Point {
  x: number;
  y: number;
}

const MAX_PATH_POINTS = 120;
const MAX_BUGS = 3;
const SPAWN_DISTANCE = 300;
const BUG_FADE_RATE = 0.0015;

function drawBug(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  size: number,
  opacity: number,
  wobble: number,
  flipX: boolean
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle + (flipX ? Math.PI : 0));
  ctx.globalAlpha = opacity;

  const s = size;

  ctx.fillStyle = "#052e2e";
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.45, s * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#073838";
  ctx.beginPath();
  ctx.ellipse(-s * 0.35, 0, s * 0.22, s * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = `rgba(0, 200, 200, ${opacity * 0.15})`;
  ctx.lineWidth = 0.4;
  ctx.beginPath();
  ctx.moveTo(-s * 0.1, 0);
  ctx.lineTo(s * 0.35, 0);
  ctx.stroke();

  ctx.fillStyle = "#041e1e";
  ctx.beginPath();
  ctx.ellipse(s * 0.48, 0, s * 0.15, s * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = `rgba(0, 180, 180, ${opacity * 0.25})`;
  ctx.lineWidth = 0.5;

  const legPairs = [
    { bodyX: -s * 0.2, spread: 0.55 },
    { bodyX: 0, spread: 0.65 },
    { bodyX: s * 0.2, spread: 0.5 },
  ];
  const wo = Math.sin(wobble) * 0.08;

  for (let i = 0; i < legPairs.length; i++) {
    const leg = legPairs[i];
    const phase = i % 2 === 0 ? wo : -wo;
    const endSpread = leg.spread + phase;

    ctx.beginPath();
    ctx.moveTo(leg.bodyX, s * 0.28);
    ctx.quadraticCurveTo(
      leg.bodyX + s * 0.05,
      s * (0.4 + phase * 0.3),
      leg.bodyX - s * 0.05,
      s * endSpread
    );
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(leg.bodyX, -s * 0.28);
    ctx.quadraticCurveTo(
      leg.bodyX + s * 0.05,
      -s * (0.4 + phase * 0.3),
      leg.bodyX - s * 0.05,
      -s * endSpread
    );
    ctx.stroke();
  }

  ctx.fillStyle = `rgba(0, 200, 210, ${opacity * 0.5})`;
  ctx.beginPath();
  ctx.arc(s * 0.52, -s * 0.07, s * 0.03, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(s * 0.52, s * 0.07, s * 0.03, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = `rgba(0, 180, 180, ${opacity * 0.15})`;
  ctx.lineWidth = 0.35;
  ctx.beginPath();
  ctx.moveTo(s * 0.58, -s * 0.05);
  ctx.quadraticCurveTo(s * 0.78, -s * 0.25, s * 0.7, -s * 0.4);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s * 0.58, s * 0.05);
  ctx.quadraticCurveTo(s * 0.78, s * 0.25, s * 0.7, s * 0.4);
  ctx.stroke();

  ctx.restore();
}

export function CursorBugs() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pathRef = useRef<Point[]>([]);
  const bugsRef = useRef<BugState[]>([]);
  const idCounterRef = useRef(0);
  const lastSpawnPosRef = useRef<Point | null>(null);
  const animFrameRef = useRef(0);
  const lastMouseRef = useRef<Point>({ x: 0, y: 0 });

  const spawnBug = useCallback(() => {
    if (bugsRef.current.length >= MAX_BUGS) return;
    if (pathRef.current.length < 10) return;

    bugsRef.current.push({
      id: idCounterRef.current++,
      pathIndex: pathRef.current.length - 1,
      progress: 0,
      speed: 0.15 + Math.random() * 0.2,
      opacity: 0.2 + Math.random() * 0.12,
      size: 5 + Math.random() * 3,
      wobble: Math.random() * Math.PI * 2,
      wobbleSpeed: 1.5 + Math.random() * 1.5,
      flipX: Math.random() > 0.5,
    });
  }, []);

  useEffect(() => {
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    const onMouseMove = (e: MouseEvent) => {
      const point = { x: e.clientX, y: e.clientY };
      lastMouseRef.current = point;

      const path = pathRef.current;
      if (path.length > 0) {
        const last = path[path.length - 1];
        const dx = point.x - last.x;
        const dy = point.y - last.y;
        if (dx * dx + dy * dy < 16) return;
      }

      path.push(point);
      if (path.length > MAX_PATH_POINTS) {
        path.splice(0, path.length - MAX_PATH_POINTS);
        for (const bug of bugsRef.current) {
          bug.pathIndex = Math.max(0, bug.pathIndex - (path.length - MAX_PATH_POINTS));
        }
      }

      const spawnPos = lastSpawnPosRef.current;
      if (!spawnPos) {
        lastSpawnPosRef.current = point;
      } else {
        const dx = point.x - spawnPos.x;
        const dy = point.y - spawnPos.y;
        if (dx * dx + dy * dy > SPAWN_DISTANCE * SPAWN_DISTANCE) {
          spawnBug();
          lastSpawnPosRef.current = point;
        }
      }
    };

    window.addEventListener("mousemove", onMouseMove, { passive: true });

    let lastTime = performance.now();

    const animate = (now: number) => {
      const dt = Math.min((now - lastTime) / 16.67, 3);
      lastTime = now;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const path = pathRef.current;
      const bugs = bugsRef.current;

      for (let i = bugs.length - 1; i >= 0; i--) {
        const bug = bugs[i];
        bug.wobble += bug.wobbleSpeed * dt * 0.04;
        bug.pathIndex -= bug.speed * dt;
        bug.opacity -= BUG_FADE_RATE * dt;

        if (bug.opacity <= 0 || bug.pathIndex <= 1) {
          bugs.splice(i, 1);
          continue;
        }

        const idx = Math.floor(bug.pathIndex);
        const frac = bug.pathIndex - idx;

        if (idx < 0 || idx >= path.length - 1) {
          bugs.splice(i, 1);
          continue;
        }

        const p0 = path[idx];
        const p1 = path[idx + 1];
        const x = p0.x + (p1.x - p0.x) * frac;
        const y = p0.y + (p1.y - p0.y) * frac;
        const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);

        drawBug(ctx, x, y, angle, bug.size, bug.opacity, bug.wobble, bug.flipX);
      }

      animFrameRef.current = requestAnimationFrame(animate);
    };

    animFrameRef.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [spawnBug]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="fixed inset-0 z-[1] pointer-events-none"
      style={{ mixBlendMode: "screen" }}
    />
  );
}
