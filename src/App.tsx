import { useEffect, useRef, useState } from 'react';
import { Engine } from './engine/Engine';
import { useStore } from './state/store';
import { EditPanel } from './components/EditPanel';
import { EditorToolbar } from './components/EditorToolbar';
import { Minimap } from './ui/Minimap';
import { Contours } from './ui/Contours';
import { Relief } from './ui/Relief';
import { BuildingCard, Dock, Help, Hud, Loader, PlaceBar, TimePanel, Tools } from './ui/Panels';

export function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const mode = useStore((s) => s.mode);
  const loading = useStore((s) => s.loading);

  useEffect(() => {
    try {
      const instance = new Engine(canvas.current!);
      setEngine(instance);
      return () => instance.dispose();
    } catch (error) {
      console.error(error);
      useStore.getState().set({ loading: null, error: 'Браузер не дал доступ к WebGL — 3D-сцену показать не получится. Перезапустите браузер или включите аппаратное ускорение.' });
    }
  }, []);

  return (
    <div className={`app mode-${mode}`}>
      <canvas ref={canvas} className="scene" />
      <PlaceBar />
      {mode === 'overview' ? <BuildingCard /> : engine && !loading && <Minimap engine={engine} />}
      {mode === 'overview' && !loading && (
        <>
          <EditPanel />
          <EditorToolbar />
        </>
      )}
      <Hud />
      <Tools />
      <Dock />
      <TimePanel />
      <Contours />
      <Relief />
      <Help />
      <Loader />
    </div>
  );
}
