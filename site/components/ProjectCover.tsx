"use client";

import Image from "next/image";
import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState } from "react";

/* Тот же отдельный чанк просмотра, что у SheetGallery: к первому нажатию по обложке
   он обычно уже загружен лентой листов, а исполнение не попадает в переход. */
const SheetViewer = dynamic(() => import("./SheetViewer"), { ssr: false });

interface Props {
  cover: { src: string; width: number; height: number };
  projectTitle: string;
  className?: string;
}

/**
 * Планшет проекта на втором экране: по нажатию открывается в том же полноэкранном
 * просмотре, что и листы (перелёт с места, приближение колесом), а не отдельной вкладкой.
 */
export default function ProjectCover({ cover, projectTitle, className }: Props) {
  const [open, setOpen] = useState(false);
  // Просмотр монтируется при первом открытии и дальше остаётся (анимации закрытия)
  const [everOpened, setEverOpened] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const items = useMemo(
    () => [{ key: "cover", ...cover, title: "Обложка проекта", alt: `${projectTitle} — обложка проекта` }],
    [cover, projectTitle],
  );
  const origin = useCallback(() => ref.current, []);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={className}
        onClick={() => {
          setEverOpened(true);
          setOpen(true);
        }}
        aria-label={`Обложка проекта «${projectTitle}» — открыть в полном размере`}
      >
        <Image
          src={cover.src}
          alt={`${projectTitle} — обложка проекта`}
          width={cover.width}
          height={cover.height}
          sizes="(max-width: 1240px) 100vw, 1100px"
        />
      </button>
      {everOpened && (
        <SheetViewer
          items={items}
          index={open ? 0 : null}
          onIndexChange={() => {}}
          onClose={close}
          projectTitle={projectTitle}
          origin={origin}
        />
      )}
    </>
  );
}
