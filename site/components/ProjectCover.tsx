"use client";

import Image from "next/image";
import { useCallback, useMemo, useRef, useState } from "react";
import SheetViewer from "./SheetViewer";

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
        onClick={() => setOpen(true)}
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
      <SheetViewer
        items={items}
        index={open ? 0 : null}
        onIndexChange={() => {}}
        onClose={close}
        projectTitle={projectTitle}
        origin={origin}
      />
    </>
  );
}
