export interface IProjectionRunRepository {
  getLatestRun(): Promise<any>;
}
