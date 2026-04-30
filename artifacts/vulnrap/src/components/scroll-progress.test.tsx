import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ScrollProgress } from "./scroll-progress";

function setScrollMetrics(scrollTop: number, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    value: scrollTop,
    writable: true,
  });
}

describe("ScrollProgress", () => {
  let rafSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Run rAF callbacks synchronously so we can observe state updates
    // without having to advance real timers in tests.
    rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });

  afterEach(() => {
    rafSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("renders a 0% bar when the page is not scrollable", () => {
    setScrollMetrics(0, 600, 800);
    render(<ScrollProgress />);
    const bar = screen.getByTestId("scroll-progress-bar");
    expect(bar.style.width).toBe("0%");
  });

  it("hides the indicator from assistive tech", () => {
    setScrollMetrics(0, 600, 800);
    const { container } = render(<ScrollProgress />);
    const wrapper = container.querySelector(".scroll-progress");
    expect(wrapper?.getAttribute("aria-hidden")).toBe("true");
  });

  it("reflects the scroll percentage when the user scrolls", () => {
    setScrollMetrics(0, 2000, 1000);
    render(<ScrollProgress />);
    expect(screen.getByTestId("scroll-progress-bar").style.width).toBe("0%");

    setScrollMetrics(500, 2000, 1000);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(screen.getByTestId("scroll-progress-bar").style.width).toBe("50%");

    setScrollMetrics(1000, 2000, 1000);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(screen.getByTestId("scroll-progress-bar").style.width).toBe("100%");
  });

  it("clamps the value into [0, 100] when scroll metrics overshoot", () => {
    setScrollMetrics(99999, 2000, 1000);
    render(<ScrollProgress />);
    expect(screen.getByTestId("scroll-progress-bar").style.width).toBe("100%");
  });
});
