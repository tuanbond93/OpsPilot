import type { IPlaybookDirectiveRepository, PlaybookDirective } from "../interfaces/IPlaybookDirectiveRepository";

export class MockPlaybookDirectiveRepository implements IPlaybookDirectiveRepository {
  constructor(readonly directives: PlaybookDirective[] = []) {}
  async getActiveDirectives(): Promise<PlaybookDirective[]> { return this.directives.filter((directive) => directive); }
}
