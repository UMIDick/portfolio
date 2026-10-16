"use client";

import { useEffect } from "react";
import { idlePause } from "@/lib/idle";

/** Совпадает с медиазапросом content-visibility для экранов в globals.css. */
const MOBILE = "(max-width: 760px), (max-height: 559px)";

/**
 * На телефоне экраны за пределами окна скрыты content-visibility (globals.css):
 * гидрация и переходы раскладывают только видимую часть страницы — так «раскрытия»
 * и переходы не раскладывают её всю. Но если оставить как есть, цена разворота
 * вылезает потом при прокрутке (секция раскладывается прямо в свайпе — рывок).
 * Поэтому в простое после загрузки или перехода скрытые экраны раскладываются
 * заранее, по одному за кадр; начал листать раньше — браузер развернёт сам, как без нас.
 * Монтируется в PageSheet — заново на каждой странице.
 */
export default function RevealScreens() {
  useEffect(() => {
    if (!window.matchMedia(MOBILE).matches) return;
    let stop = false;
    void (async () => {
      // На главной при загрузке ждём конца интро (плитки летят ~2,8 с): разворот
      // резюме (сотни миллисекунд раскладки на слабом процессоре) рвал их полёт
      if (document.querySelector("[data-home]")) {
        await new Promise((r) => setTimeout(r, Math.max(0, 3200 - performance.now())));
      }
      await idlePause({ quiet: true });
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-screen]"))) {
        if (stop) return;
        el.style.setProperty("content-visibility", "visible");
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        await idlePause({ quiet: true });
      }
    })();
    return () => {
      stop = true;
    };
  }, []);
  return null;
}
