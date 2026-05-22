import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SourceReader from "@/components/SourceReader";
import type { Source } from "@/data/stories";

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "src-1",
    outlet: "The Washington Post",
    kind: "traditional",
    weight: 50,
    url: "https://example.com/article",
    minutesAgo: 10,
    headline: "Headline",
    body: ["paragraph"],
    ...overrides,
  };
}

describe("SourceReader outbound link", () => {
  it("renders an outbound link with a new-tab target when url is https", () => {
    render(<SourceReader source={makeSource()} onClose={vi.fn()} />);
    const link = screen.getByRole("link", {
      name: /Open The Washington Post article in a new tab/i,
    });
    expect(link).toHaveAttribute("href", "https://example.com/article");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("uses social-flavored aria-label for social sources", () => {
    render(
      <SourceReader
        source={makeSource({ kind: "social", outlet: "@reuters" })}
        onClose={vi.fn()}
      />
    );
    expect(
      screen.getByRole("link", {
        name: /Open original post on @reuters in a new tab/i,
      })
    ).toBeInTheDocument();
  });

  it("renders no footer link when url is `#`", () => {
    render(<SourceReader source={makeSource({ url: "#" })} onClose={vi.fn()} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Source:/i)).not.toBeInTheDocument();
  });

  it("renders no footer link when url is empty", () => {
    render(<SourceReader source={makeSource({ url: "" })} onClose={vi.fn()} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Source:/i)).not.toBeInTheDocument();
  });

  it("renders no footer link when url is not http(s)", () => {
    render(
      <SourceReader source={makeSource({ url: "javascript:alert(1)" })} onClose={vi.fn()} />
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
