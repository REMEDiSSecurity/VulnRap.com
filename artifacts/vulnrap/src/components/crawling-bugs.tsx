import { useEffect, useRef } from "react";

interface Bug {
  x: number;
  y: number;
  angle: number;
  speed: number;
  turnSpeed: number;
  size: number;
  opacity: number;
  legPhase: number;
  wiggle: number;
  targetAngle: number;
  pauseTimer: number;
}

const BUG_COUNT = 6;
const LEG_PAIRS = 3;

function createBug(w: number, h: number): Bug {
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    angle: Math.random() * Math.PI * 2,
    speed: 0.3 + Math.random() * 0.4,
    turnSpeed: 0.01 + Math.random() * 0.02,
    size: 4 + Math.random() * 3,
    opacity: 0.06 + Math.random() * 0.06,
    legPhase: Math.random() * Math.PI * 2,
    wiggle: 0,
    targetAngle: Math.random() * Math.PI * 2,
    pauseTimer: 0,
  };
}

function drawBug(ctx: CanvasRenderingContext2D, bug: Bug) {
  ctx.save();
  ctx.translate(bug.x, bug.y);
  ctx.rotate(bug.angle);
  ctx.globalAlpha = bug.opacity;

  const s = bug.size;

  ctx.fillStyle = "rgba(0, 255, 255, 0.5)";
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.5, s * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "rgba(0, 255, 255, 0.6)";
  ctx.beginPath();
  ctx.ellipse(-s * 0.55, 0, s * 0.25, s * 0.25, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(0, 255, 255, 0.4)";
  ctx.lineWidth = 0.5;

  for (let i = 0; i < LEG_PAIRS; i++) {
    const legOffset = (i - 1) * s * 0.3;
    const phase = bug.legPhase + i * (Math.PI / LEG_PAIRS);
    const legSwing = Math.sin(phase) * s * 0.3;

    ctx.beginPath();
    ctx.moveTo(legOffset, -s * 0.3);
    ctx.lineTo(legOffset + legSwing * 0.5, -s * 0.7);
    ctx.lineTo(legOffset + legSwing, -s * 1.0);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(legOffset, s * 0.3);
    ctx.lineTo(legOffset - legSwing * 0.5, s * 0.7);
    ctx.lineTo(legOffset - legSwing, s * 1.0);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(0, 255, 255, 0.3)";
  ctx.lineWidth = 0.4;
  ctx.beginPath();
  ctx.moveTo(-s * 0.75, -s * 0.15);
  ctx.quadraticCurveTo(-s * 1.1, -s * 0.5, -s * 1.3, -s * 0.3);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-s * 0.75, s * 0.15);
  ctx.quadraticCurveTo(-s * 1.1, s * 0.5, -s * 1.3, s * 0.3);
  ctx.stroke();

  ctx.restore();
}

export function CrawlingBugs() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bugsRef = useRef<Bug[]>([]);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (prefersReducedMotion.matches) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    bugsRef.current = Array.from({ length: BUG_COUNT }, () =>
      createBug(canvas.width, canvas.height)
    );

    const animate = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      for (const bug of bugsRef.current) {
        if (bug.pauseTimer > 0) {
          bug.pauseTimer -= 1;
          bug.legPhase += 0;
        } else {
          if (Math.random() < 0.005) {
            bug.pauseTimer = 60 + Math.random() * 120;
          }

          if (Math.random() < 0.01) {
            bug.targetAngle = bug.angle + (Math.random() - 0.5) * Math.PI * 0.8;
          }

          const angleDiff = bug.targetAngle - bug.angle;
          const normalizedDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
          bug.angle += normalizedDiff * bug.turnSpeed;

          bug.x += Math.cos(bug.angle) * bug.speed;
          bug.y += Math.sin(bug.angle) * bug.speed;

          bug.legPhase += bug.speed * 0.3;

          const margin = 50;
          if (bug.x < -margin) bug.x = w + margin;
          if (bug.x > w + margin) bug.x = -margin;
          if (bug.y < -margin) bug.y = h + margin;
          if (bug.y > h + margin) bug.y = -margin;

          if (bug.x < 30 || bug.x > w - 30 || bug.y < 30 || bug.y > h - 30) {
            bug.targetAngle = Math.atan2(h / 2 - bug.y, w / 2 - bug.x);
          }
        }

        drawBug(ctx, bug);
      }

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
      aria-hidden="true"
    />
  );
}
