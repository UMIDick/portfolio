"""
Рабочие чертежи из PDF заказчика → листы карусели.

Каждая страница PDF рендерится в `public/projects/<slug>/sheets/NN.jpg`,
описания листов (номер, название по ведомости альбома, размеры) пишутся
в `content/sheets/<slug>.json`.

Запуск: `npm run sheets` (нужен `pymupdf`). PDF — в `assets/working drawings/`.
"""
import json
from pathlib import Path

import pymupdf

SITE = Path(__file__).resolve().parent.parent
SRC = SITE.parent / "assets" / "working drawings"
WIDTH = 3000  # px по длинной стороне: хватает для полноэкранного просмотра с приближением
QUALITY = 82

# Названия — по ведомости рабочих чертежей в начале каждого альбома.
PROJECTS = {
    "flat": {
        "pdf": "Рабочие_чертежи_2х_комнатной_квартиры.pdf",
        "titles": [
            "Общие данные",
            "Пояснительная записка",
            "Обмерный план",
            "План демонтажа",
            "План монтажа перегородок. 1 этап",
            "План монтажа ГК-конструкций. 2 этап",
            "Обмерный план после монтажа",
            "План расстановки мебели с размерами",
            "План расстановки мебели",
            "План заполнения проёмов",
            "План подвода коммуникаций",
            "План радиаторов",
            "План напольных покрытий",
            "План расположения плинтуса",
            "План тёплого пола",
            "План потолка",
            "План расположения теневого зазора",
            "План расстановки осветительного оборудования",
            "План маркировки осветительного оборудования",
            "Спецификация осветительного оборудования",
            "План вентиляции",
            "План управления светом",
            "План розеток",
            "План отделки стен",
            "План развёрток",
            "Развёртки пом. № 1. Прихожая",
            "Развёртки пом. № 2. Гостиная",
            "Развёртки пом. № 2. Кухня",
            "Развёртки пом. № 3. Спальня",
            "Развёртки пом. № 4. Санузел",
        ],
    },
    "school": {
        "pdf": "Музыкальная школа.pdf",
        "titles": [
            "Титульный лист",
            "Общие данные",
            "Кладочный план 1-го этажа на отм. +0,000",
            "План эргономики 1-го этажа",
            "План отделки стен 1-го этажа",
            "План напольных покрытий на отм. +0,000",
            "Планы размещения сантехнического оборудования 1-го этажа",
            "План расстановки осветительного оборудования 1-го этажа",
            "План маркировки дверных проёмов 1-го этажа",
            "Аксонометрия актового зала, развёртки по актовому залу",
            "Разрез 1-1, аксонометрия разреза, аксонометрия лестницы",
            "Фасад 1-11, фасад 11-1",
            "Фасад А-И, фасад И-А",
            "Аксонометрия здания, взрыв-схема",
            "Перспективные виды",
        ],
    },
}


def main() -> None:
    for slug, cfg in PROJECTS.items():
        doc = pymupdf.open(SRC / cfg["pdf"])
        titles = cfg["titles"]
        assert doc.page_count == len(titles), f"{slug}: {doc.page_count} страниц, {len(titles)} названий"
        out = SITE / "public" / "projects" / slug / "sheets"
        out.mkdir(parents=True, exist_ok=True)
        for old in out.iterdir():
            old.unlink()
        sheets = []
        for i, page in enumerate(doc):
            zoom = WIDTH / max(page.rect.width, page.rect.height)
            pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
            name = f"{i + 1:02d}.jpg"
            pix.save(out / name, jpg_quality=QUALITY)
            sheets.append({
                "number": i + 1,
                "title": titles[i],
                "src": f"/projects/{slug}/sheets/{name}",
                "width": pix.width,
                "height": pix.height,
            })
            print(slug, name, pix.width, pix.height, f"{(out / name).stat().st_size // 1024} КБ")
        (SITE / "content" / "sheets" / f"{slug}.json").write_text(
            json.dumps(sheets, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )


if __name__ == "__main__":
    main()
