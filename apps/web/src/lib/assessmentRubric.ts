// The AI Readiness Assessment questionnaire (docs/02 — the free on-ramp). Pure
// data with no server deps, so the client form and the server-side scorer share
// one source of truth. Each question belongs to a category and each option
// carries a 1–5 score; category scores are the average of their questions.

export type Category = "usage" | "data";

export interface Option {
  label: string;
  score: 1 | 2 | 3 | 4 | 5;
}

export interface Question {
  id: string;
  category: Category;
  prompt: string;
  options: Option[];
}

export const CATEGORY_LABELS: Record<Category, string> = {
  usage: "AI usage maturity",
  data: "Data readiness",
};

export const QUESTIONS: Question[] = [
  {
    id: "usage_breadth",
    category: "usage",
    prompt: "How is AI used across the organization today?",
    options: [
      { label: "Not at all", score: 1 },
      { label: "Ad-hoc individual chat use", score: 2 },
      { label: "Some teams use it regularly", score: 3 },
      { label: "Standardized in several workflows", score: 4 },
      { label: "Agentic/automated workflows in production", score: 5 },
    ],
  },
  {
    id: "usage_adoption",
    category: "usage",
    prompt: "What share of staff use AI in their daily work?",
    options: [
      { label: "Under 10%", score: 1 },
      { label: "About 25%", score: 2 },
      { label: "About half", score: 3 },
      { label: "About 75%", score: 4 },
      { label: "Over 90%", score: 5 },
    ],
  },
  {
    id: "usage_roi",
    category: "usage",
    prompt: "Do you measure the ROI or time saved from AI?",
    options: [
      { label: "Not at all", score: 1 },
      { label: "Anecdotally", score: 2 },
      { label: "Some team metrics", score: 3 },
      { label: "Tracked per team", score: 4 },
      { label: "Attributed to dollars saved", score: 5 },
    ],
  },
  {
    id: "data_docs",
    category: "data",
    prompt: "Is your institutional knowledge and process documentation centralized?",
    options: [
      { label: "Tribal / in people's heads", score: 1 },
      { label: "Some scattered docs", score: 2 },
      { label: "Mostly documented", score: 3 },
      { label: "Centralized", score: 4 },
      { label: "Centralized, structured, maintained", score: 5 },
    ],
  },
  {
    id: "data_standardized",
    category: "data",
    prompt: "How standardized are your key recurring workflows?",
    options: [
      { label: "Everyone improvises", score: 1 },
      { label: "Loose conventions", score: 2 },
      { label: "Documented for some", score: 3 },
      { label: "Standardized for most", score: 4 },
      { label: "Fully standardized", score: 5 },
    ],
  },
  {
    id: "data_accessible",
    category: "data",
    prompt: "Is your business data reachable by systems (APIs), not just PDFs and email?",
    options: [
      { label: "Locked in documents/email", score: 1 },
      { label: "A few systems have APIs", score: 2 },
      { label: "Core systems are reachable", score: 3 },
      { label: "Most data is API-accessible", score: 4 },
      { label: "Fully API-accessible", score: 5 },
    ],
  },
];

// A free-text prompt that feeds the qualitative opportunity analysis. Not scored.
export const WORKFLOW_PROMPT =
  "Describe one recurring, time-consuming workflow your experts do by hand " +
  "(and roughly how many people do it and how long it takes).";

export type Answers = Record<string, number>; // questionId -> chosen option score

export interface CategoryScore {
  category: Category;
  label: string;
  score: number; // 1–5, one decimal
}

// Deterministic scoring: each category = average of its answered questions.
export function scoreCategories(answers: Answers): CategoryScore[] {
  return (["usage", "data"] as Category[]).map((category) => {
    const qs = QUESTIONS.filter((q) => q.category === category);
    const vals = qs.map((q) => answers[q.id]).filter((v) => typeof v === "number");
    const score = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    return {
      category,
      label: CATEGORY_LABELS[category],
      score: Math.round(score * 10) / 10,
    };
  });
}

export function overallScore(answers: Answers): number {
  const cats = scoreCategories(answers);
  const vals = cats.map((c) => c.score).filter((s) => s > 0);
  return vals.length
    ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
    : 0;
}
