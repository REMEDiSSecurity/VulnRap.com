// Task #634 — UI test for the public PhraseSuggestionForm. Mocks the
// generated `submitPhraseSuggestion` API call so we can assert the
// component's three contracts without standing up a server: validation
// gates the submit button, a successful submission swaps the form for a
// thank-you panel, and a 429 rate-limit response renders a friendly
// cooldown banner instead of a generic toast.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const { submitPhraseSuggestionMock, toastMock } = vi.hoisted(() => ({
  submitPhraseSuggestionMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@workspace/api-client-react",
  );
  return {
    ...actual,
    submitPhraseSuggestion: (...args: unknown[]) => submitPhraseSuggestionMock(...args),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
  toast: toastMock,
}));

import PhraseSuggestionForm from "./phrase-suggestion-form";
import { ApiError } from "@workspace/api-client-react";

beforeEach(() => {
  submitPhraseSuggestionMock.mockReset();
  toastMock.mockReset();
});

describe("PhraseSuggestionForm", () => {
  it("disables the submit button until the phrase reaches the minimum length", () => {
    render(<PhraseSuggestionForm />);
    const submit = screen.getByTestId("phrase-suggestion-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("phrase-suggestion-text"), {
      target: { value: "ab" },
    });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("phrase-suggestion-text"), {
      target: { value: "could potentially allow attackers" },
    });
    expect(submit.disabled).toBe(false);
  });

  it("submits the trimmed text + selected category and renders the thank-you panel on success", async () => {
    submitPhraseSuggestionMock.mockResolvedValueOnce({
      ok: true,
      duplicate: false,
      id: 7,
      message: "Thanks!",
    });
    render(<PhraseSuggestionForm />);

    fireEvent.change(screen.getByTestId("phrase-suggestion-text"), {
      target: { value: "  leverages cutting-edge synergy  " },
    });
    fireEvent.click(screen.getByTestId("phrase-suggestion-category-ai-self-disclosure"));
    fireEvent.change(screen.getByTestId("phrase-suggestion-context"), {
      target: { value: "saw it in three reports" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("phrase-suggestion-submit"));
    });

    expect(submitPhraseSuggestionMock).toHaveBeenCalledWith({
      text: "leverages cutting-edge synergy",
      category: "ai-self-disclosure",
      context: "saw it in three reports",
    });
    await waitFor(() => {
      expect(screen.getByTestId("phrase-suggestion-form-success")).toBeInTheDocument();
    });
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Suggestion received" }),
    );
  });

  it("surfaces a daily-limit cooldown banner when the server replies with 429", async () => {
    const fakeResponse = {
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers(),
      url: "/public/phrase-suggestions",
    } as unknown as Response;
    submitPhraseSuggestionMock.mockRejectedValueOnce(
      new ApiError(
        fakeResponse,
        { error: "Daily limit reached.", dailyLimit: 5, retryAfterHours: 24 },
        { method: "POST", url: "/public/phrase-suggestions" },
      ),
    );

    render(<PhraseSuggestionForm />);
    fireEvent.change(screen.getByTestId("phrase-suggestion-text"), {
      target: { value: "this is a vague handwavy phrase" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("phrase-suggestion-submit"));
    });

    const banner = await screen.findByTestId("phrase-suggestion-cooldown");
    expect(banner.textContent).toMatch(/daily limit reached/i);
    expect(banner.textContent).toMatch(/5 suggestions per day/i);
    expect(banner.textContent).toMatch(/24 hours/i);
    const submit = screen.getByTestId("phrase-suggestion-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});
