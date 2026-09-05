// UI-Schicht der Tagesbudget-Karte (ALM 2.5): auf Element-Tree-Ebene wie
// die Digest- und Memory-Karten-Tests — die Card ist absichtlich hook-frei
// (der Eingabestand liegt kontrolliert bei der Seite), deshalb braucht es
// kein DOM. Siehe test/tree.tsx.
import { describe, expect, test, vi } from "vitest";
import { render, textOf, findOneByText, click } from "../test/tree";
import { MissionBudgetCardBody, budgetDetailLine, parseBudgetInput } from "./MissionDetail";
import type { MissionDetail } from "../lib/api";

type Budget = NonNullable<MissionDetail["budget"]>;

function budget(overrides: Partial<Budget> = {}): Budget {
  return {
    missionBudgetUsd: 10,
    policyDefaultUsd: null,
    effectiveUsd: 10,
    spentKnownUsd: 3.4,
    unknownRuns: 2,
    graceToday: false,
    ...overrides,
  };
}

function body(overrides: Partial<Parameters<typeof MissionBudgetCardBody>[0]> = {}) {
  return {
    budget: budget(),
    inputValue: "",
    saving: false,
    onInputChange: () => {},
    onSave: () => {},
    ...overrides,
  };
}

describe("MissionBudgetCardBody", () => {
  test("zeigt den heutigen Stand mit unknown-Zähler und die Herkunft des wirksamen Werts", () => {
    const root = render(<MissionBudgetCardBody {...body()} />);
    expect(textOf(root)).toContain("Daily budget");
    expect(textOf(root)).toContain("$3.40 von $10.00 · 2 Läufe ohne Kostendaten");
    expect(textOf(root)).toContain("eigenes Mission-Budget");
    expect(textOf(root)).toContain("nur verschärfen");
  });

  test("der Gnaden-Status ist sichtbar: Budget überschritten, heute freigegeben", () => {
    const root = render(<MissionBudgetCardBody {...body({ budget: budget({ graceToday: true }) })} />);
    expect(textOf(root)).toContain("Budget überschritten, heute freigegeben");
    const withoutGrace = render(<MissionBudgetCardBody {...body()} />);
    expect(textOf(withoutGrace)).toContain("keine Freigabe heute");
  });

  test("ohne Budget steht da, dass KEINS gilt — nie ein Fake-Limit", () => {
    const root = render(
      <MissionBudgetCardBody {...body({ budget: budget({ missionBudgetUsd: null, policyDefaultUsd: null, effectiveUsd: null, spentKnownUsd: null, unknownRuns: null, graceToday: false }) })} />,
    );
    expect(textOf(root)).toContain("Kein Tagesbudget gesetzt — heute gilt keine Grenze.");
    expect(textOf(root)).not.toContain("$0.00");
    expect(textOf(root)).toContain("policy.json");
  });

  test("ein Tag nur mit unbekannten Kosten behauptet keine 0.00", () => {
    const root = render(
      <MissionBudgetCardBody {...body({ budget: budget({ spentKnownUsd: 0 }) })} />,
    );
    expect(textOf(root)).toContain("bekannt ist nichts von $10.00");
    expect(textOf(root)).toContain("2 Läufe ohne Kostendaten");
  });

  test("der Save-Button reicht leer = null (kein Budget) und die Zahl durch; der Eingabestand kommt von der Seite", () => {
    const onInputChange = vi.fn();
    const onSave = vi.fn();
    const root = render(<MissionBudgetCardBody {...body({ inputValue: "7.5", onInputChange, onSave })} />);

    const input = findOneByText(root, "input", "");
    (input.props as { onChange: (event: { target: { value: string } }) => void }).onChange({ target: { value: "9" } });
    expect(onInputChange).toHaveBeenCalledWith("9");

    click(findOneByText(root, "button", "Budget setzen"));
    expect(onSave).toHaveBeenCalledWith(7.5);

    const empty = render(<MissionBudgetCardBody {...body({ inputValue: "  ", onSave })} />);
    click(findOneByText(empty, "button", "Budget setzen"));
    expect(onSave).toHaveBeenLastCalledWith(null); // leer = Budget entfernen
  });

  test("der Saving-Zustand sperrt den Button", () => {
    const root = render(<MissionBudgetCardBody {...body({ saving: true, inputValue: "1" })} />);
    const button = findOneByText(root, "button", "Speichern…");
    expect((button.props as { disabled?: boolean }).disabled).toBe(true);
  });
});

describe("budgetDetailLine", () => {
  test("die eine Zeile, ehrlich in beide Richtungen", () => {
    expect(budgetDetailLine(budget())).toBe("$3.40 von $10.00 · 2 Läufe ohne Kostendaten");
    expect(
      budgetDetailLine(budget({ spentKnownUsd: 0, unknownRuns: 0 })),
    ).toBe("$0.00 von $10.00");
    expect(
      budgetDetailLine(budget({ effectiveUsd: null, spentKnownUsd: null, unknownRuns: null })),
    ).toBe("Kein Tagesbudget gesetzt — heute gilt keine Grenze.");
  });
});

describe("parseBudgetInput", () => {
  test("leer ist null (kein Budget), Unsinn bleibt außen vor", () => {
    expect(parseBudgetInput("")).toBeNull();
    expect(parseBudgetInput("  ")).toBeNull();
    expect(parseBudgetInput("12")).toBe(12);
    expect(parseBudgetInput("0.25")).toBeCloseTo(0.25);
  });
});
