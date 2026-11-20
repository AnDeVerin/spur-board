// The stand's one GitHub Project over GraphQL, `stand-org/1`, which a ready-for-dev column may
// mirror. The GitHub Issues fake owns each issue's item; the PR fake answers the GraphQL URL.
import { PROJECT_OPTIONS, type IssueProject } from './github-issues.ts';
import { FakeViolation } from './fetch.ts';
import { NotFound, type Args, type Wire, type WireObject } from './graphql.ts';

const PROJECT_OWNER = 'stand-org';
const PROJECT_NUMBER = 1;
const PROJECT_ID = 'PVT_stand_1';
const PROJECT_TITLE = 'Stand roadmap';
const STATUS_FIELD = 'Status';
const optionId = (option: string): string => `PVTSSO_stand_${option.toLowerCase()}`;

/** The first page of `items`; the mirror document reads no later page, and no cursor. */
function firstPage(items: readonly Wire[], args: Args): WireObject {
  const first = Number(args['first']);
  return { nodes: items.slice(0, first), pageInfo: { hasNextPage: items.length > first } };
}

/** The Project's `Status` field; any other field is missing, with GitHub's live message. */
function fieldView(name: unknown): Wire {
  return name === STATUS_FIELD
    ? {
        __typename: 'ProjectV2SingleSelectField',
        id: 'PVTSSF_stand_1_status',
        options: PROJECT_OPTIONS.map((option) => ({ id: optionId(option), name: option })),
      }
    : new NotFound(
        `Could not resolve to a Unions::ProjectV2FieldConfiguration with the name ${String(name)}`,
      );
}

/** `stand-org` is an Organization owning Project 1; another number is missing, as on GitHub. */
export function projectOwnerView(login: unknown): Wire {
  if (login !== PROJECT_OWNER)
    return new NotFound(
      `Could not resolve to a RepositoryOwner with the login of '${String(login)}'.`,
    );
  return {
    __typename: 'Organization',
    projectV2: (args: Args) =>
      args['number'] === PROJECT_NUMBER
        ? {
            id: PROJECT_ID,
            title: PROJECT_TITLE,
            field: (fieldArgs: Args) => fieldView(fieldArgs['name']),
          }
        : new NotFound(
            `Could not resolve to a ProjectV2 with the number ${String(args['number'])}.`,
          ),
  };
}

/**
 * The open issues of `repo` from the GitHub Issues fake, oldest first, each with its item in the
 * Project when it has one.
 */
export function projectIssuesView(
  repo: string,
  args: Args,
  issueProjects: ((owner: string, name: string) => readonly IssueProject[]) | undefined,
): WireObject {
  const states = args['states'] as readonly string[];
  if (states.length !== 1 || states[0] !== 'OPEN')
    throw new FakeViolation(`Only open issues are modelled, not ${states.join(', ')}.`);
  if (issueProjects === undefined)
    throw new FakeViolation(`No GitHub Issues fake answers the issues of ${repo}.`);
  const [owner = '', name = ''] = repo.split('/');
  const nodes = issueProjects(owner, name).map(({ number, project }) => {
    const items =
      project === null
        ? []
        : [
            {
              isArchived: project.archived,
              project: { id: PROJECT_ID },
              fieldValueByName: (fieldArgs: Args) =>
                fieldArgs['name'] === STATUS_FIELD && project.option !== null
                  ? {
                      __typename: 'ProjectV2ItemFieldSingleSelectValue',
                      optionId: optionId(project.option),
                    }
                  : null,
            },
          ];
    return {
      number,
      projectItems: (itemArgs: Args) =>
        firstPage(
          itemArgs['includeArchived'] === false ? items.filter((item) => !item.isArchived) : items,
          itemArgs,
        ),
    };
  });
  return firstPage(nodes, args);
}
