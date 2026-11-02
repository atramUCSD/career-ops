import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { stageLabel, STAGE_IDS } from "@/lib/setup-wizard.mjs";

type Props = { params: Promise<{ stage: string }> };

// The title is the screen reader's cue: Next's route announcer reads it in the
// navigation commit, before the camera lands.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { stage } = await params;
  return { title: `${stageLabel(stage)} · Setup · career-ops` };
}

// The stage itself renders in the layout's camera world; this route only
// validates the segment so /setup/anything-else is a 404.
export default async function SetupStage({ params }: Props) {
  const { stage } = await params;
  if (!STAGE_IDS.includes(stage)) notFound();
  return null;
}
