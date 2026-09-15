import { useEffect, type RefObject } from 'react';
import type { ReadingMap } from '../domain/types';
import { VITAL_BY_KEY } from '../domain/vitals';

interface DemoMonitorProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  readings: ReadingMap;
}

export function DemoMonitor({ canvasRef, readings }: DemoMonitorProps) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    let frame = 0;
    let animationId = 0;

    const drawWave = (y: number, color: string, amplitude: number, speed: number) => {
      context.beginPath();
      for (let x = 0; x <= canvas.width; x += 4) {
        const phase = ((x + frame * speed) % 180) / 180;
        let pulse = Math.sin(phase * Math.PI * 2) * 2;
        if (phase > 0.46 && phase < 0.5) pulse -= amplitude * 0.3;
        if (phase >= 0.5 && phase < 0.53) pulse += amplitude;
        if (phase >= 0.53 && phase < 0.57) pulse -= amplitude * 0.45;
        const pointY = y - pulse;
        if (x === 0) context.moveTo(x, pointY);
        else context.lineTo(x, pointY);
      }
      context.strokeStyle = color;
      context.lineWidth = 2;
      context.stroke();
    };

    const text = (value: string | null, x: number, y: number, size: number, color: string) => {
      context.fillStyle = color;
      context.font = `600 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      context.fillText(value ?? '—', x, y);
    };

    const label = (value: string, x: number, y: number, color: string) => {
      context.fillStyle = color;
      context.globalAlpha = 0.75;
      context.font = '600 18px system-ui, sans-serif';
      context.fillText(value, x, y);
      context.globalAlpha = 1;
    };

    const draw = () => {
      frame += 1;
      const gradient = context.createLinearGradient(0, 0, 960, 540);
      gradient.addColorStop(0, '#071718');
      gradient.addColorStop(1, '#101c22');
      context.fillStyle = gradient;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = 'rgba(255,255,255,.055)';
      context.lineWidth = 1;
      for (let y = 54; y < canvas.height; y += 54) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(canvas.width, y);
        context.stroke();
      }

      label('ECG  II', 35, 33, VITAL_BY_KEY.hr.color);
      text(readings.hr.display, 35, 127, 82, VITAL_BY_KEY.hr.color);
      drawWave(150, VITAL_BY_KEY.hr.color, 30, 3);
      label('RESP /min', 690, 180, VITAL_BY_KEY.rr.color);
      text(readings.rr.display, 690, 265, 72, VITAL_BY_KEY.rr.color);
      context.fillStyle = 'rgba(255,255,255,.42)';
      context.font = '600 18px system-ui, sans-serif';
      context.fillText('HR + RR · DEMO SIGNAL', 35, 245);
      context.font = '500 13px system-ui, sans-serif';
      context.fillText('PET OR / DEMO SIGNAL', 35, 512);
      animationId = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(animationId);
  }, [canvasRef, readings]);

  return <canvas ref={canvasRef} className="monitor-media" width="960" height="540" aria-label="模拟监护仪画面" />;
}
