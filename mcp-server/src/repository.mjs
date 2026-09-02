import { createRepositoryExecutor } from './repositories/internal/repository-helpers.mjs';
import { createOrganizationRepository, createDepartmentResolver } from './repositories/organization-repository.mjs';
import { createTaskReadRepository } from './repositories/task-read-repository.mjs';
import { createTaskPeopleReader, createTaskPeopleRepository } from './repositories/task-people-repository.mjs';
import { createOkrRepository } from './repositories/okr-repository.mjs';
import { createReviewGapRepository } from './repositories/review-gap-repository.mjs';
import { createProcessRepository } from './repositories/process-repository.mjs';

export function createReadRepository({
  createUserClient,
  getContext,
  requestTimeoutMs,
  logger = console,
  identityRepository,
  now = Date.now,
}) {
  const execute = createRepositoryExecutor({ createUserClient, getContext, logger });
  const resolveDepartmentInput = createDepartmentResolver({ requestTimeoutMs, identityRepository });
  const enrichTaskPeople = createTaskPeopleReader({ requestTimeoutMs });
  return Object.freeze({
    ...createOrganizationRepository({ execute, requestTimeoutMs }),
    ...createTaskReadRepository({
      execute,
      requestTimeoutMs,
      identityRepository,
      resolveDepartmentInput,
      enrichTaskPeople,
      now,
    }),
    ...createTaskPeopleRepository({ execute, requestTimeoutMs, resolveDepartmentInput }),
    ...createOkrRepository({ execute, requestTimeoutMs, resolveDepartmentInput }),
    ...createReviewGapRepository({ execute, requestTimeoutMs, resolveDepartmentInput }),
    ...createProcessRepository({ execute, requestTimeoutMs }),
  });
}
