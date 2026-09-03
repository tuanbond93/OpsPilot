export type PlaybookDirective = {
  id: string;
  policyVersion: string;
  reasonCode: string;
  followupState: string | null;
  warehouseId: string | null;
  zoneName: string | null;
  actionCode: string;
  polarity: "DO" | "DONT";
  priority: number;
};

export interface IPlaybookDirectiveRepository {
  getActiveDirectives(): Promise<PlaybookDirective[]>;
}
