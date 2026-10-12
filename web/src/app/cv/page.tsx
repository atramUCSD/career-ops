import { CvEditor } from "@/components/cv-editor";
import { PanelFindings } from "@/components/panel-findings";
import { Card } from "@/components/ui/card";
import { latestMasterRun } from "@/lib/core/hiring-panel";

export const dynamic = "force-dynamic";

export default async function CvPage() {
  const run = await latestMasterRun();
  return (
    <CvEditor
      footer={
        run && (
          <Card className="mt-8">
            <PanelFindings run={run} />
          </Card>
        )
      }
    />
  );
}
