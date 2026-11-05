import type { SwarmDocSwarm } from "./doc-types.js";

/**
 * Starting points for a new swarm in the dashboard's studio. Each is the body of one swarm
 * (the studio picks its name), written to pass the swarm schema on its own inside any file that
 * has a `defaults.model` or none. Read-only roles disallow the editing tools.
 *
 * Pure data: nothing imports this from config.ts or a hook.
 */

export interface SwarmTemplate {
  id: string;
  name: string;
  description: string;
  /** One line on when to pick it. */
  useWhen: string;
  swarm: SwarmDocSwarm;
}

const READ_ONLY = ["Edit", "Write", "NotebookEdit"];

export const SWARM_TEMPLATES: readonly SwarmTemplate[] = [
  {
    id: "feature",
    name: "Feature team",
    description: "Plan, build, test and review a change to the codebase.",
    useWhen:
      "You have a goal that touches several files and wants a design, code, tests and a review.",
    swarm: {
      description: "Plan, build, test and review a change to the codebase.",
      topology: "hierarchical",
      max_agents: 4,
      instructions:
        "Break the goal into tasks one worker can finish in one go, each naming the files it touches.\nLet the architect design first, fan the coding tasks out, then test, then review.\n",
      agents: {
        architect: {
          description: "Designs the change from the code graph, the history and past decisions.",
          model: "opus",
          disallowed_tools: [...READ_ONLY],
          memory_tags: ["decision", "constraint"],
          prompt:
            'Study the affected code with em_architecture, em_symbols and em_graph_impact before proposing anything.\nCheck em_recall for decisions and constraints that apply.\nPost the design under the blackboard key "design": files to change, the approach, the risks.\n',
        },
        coder: {
          description: "Implements one task at a time with the smallest diff that works.",
          count: 2,
          prompt:
            'Read the "design" note first: em_swarm {action:"read", key:"design"}.\nBefore editing a file run em_history {action:"file", path} and respect its fix record.\nKeep the change minimal and consistent with the surrounding code, and run the relevant tests.\n',
        },
        tester: {
          description: "Writes and runs tests that pin the new behaviour and its edge cases.",
          prompt:
            "Cover the behaviour the task describes, including edge cases and failure paths.\nRun the tests and report exact failures. Never weaken a test to make it pass.\n",
        },
        reviewer: {
          description: "Adversarial reviewer that tries to break the change before it ships.",
          model: "opus",
          disallowed_tools: [...READ_ONLY],
          memory_tags: ["constraint", "preference"],
          prompt:
            'Review the diff for correctness bugs, missed edge cases, broken conventions and missing tests.\nEvery finding needs a concrete failing input or scenario.\nDo not fix anything yourself: add each finding as a task for the coder role with\nem_swarm {action:"plan", tasks:[{title, detail, role:"coder"}]}.\n',
        },
      },
    },
  },
  {
    id: "review",
    name: "Review panel",
    description: "Review the working tree from several angles at once.",
    useWhen: "A change is ready and you want independent reviewers, each with one concern.",
    swarm: {
      description: "Review the working tree from several angles at once.",
      topology: "mesh",
      max_agents: 3,
      agents: {
        correctness: {
          description: "Hunts for logic errors and unhandled edge cases.",
          disallowed_tools: [...READ_ONLY],
          prompt:
            'Find bugs, each with a concrete failing input. Post each under the key "finding-<n>".',
        },
        security: {
          description: "Looks for injection, path traversal, leaked secrets and unsafe defaults.",
          disallowed_tools: [...READ_ONLY],
          prompt: "Report only exploitable issues, each with the input that triggers it.",
        },
        tests: {
          description: "Checks that every changed behaviour has a test that would fail without it.",
          disallowed_tools: [...READ_ONLY],
          prompt: "List untested behaviour together with the test you would add.",
        },
      },
    },
  },
  {
    id: "research",
    name: "Research group",
    description: "Investigate a question from several sources and write up what was found.",
    useWhen: "You need an answer from the code, the docs and the history before deciding anything.",
    swarm: {
      description: "Investigate a question from several sources and write up what was found.",
      topology: "mesh",
      max_agents: 3,
      instructions:
        "Split the question into angles, one per researcher, then let the synthesizer combine the findings.\nEvery claim needs its source: a file and line, a document, or a commit.\n",
      agents: {
        researcher: {
          description: "Investigates one angle of the question and posts what it found.",
          count: 2,
          disallowed_tools: [...READ_ONLY],
          prompt:
            'Answer your angle from the code graph, the indexed docs and the history (em_symbols, em_docs, em_history).\nPost the findings under the key "finding-<angle>", each with its source.',
        },
        synthesizer: {
          description: "Combines the findings into one answer and names what is still unknown.",
          disallowed_tools: [...READ_ONLY],
          prompt:
            'Read every "finding-*" note. Post the answer under the key "answer": the conclusion, the evidence, the open questions.\nWhere findings disagree, say so rather than picking one.',
        },
      },
    },
  },
  {
    id: "bugfix",
    name: "Bug squad",
    description: "Find the cause of a bug, fix it and pin it with a test.",
    useWhen: "You have a failing behaviour and want the cause found before anything is changed.",
    swarm: {
      description: "Find the cause of a bug, fix it and pin it with a test.",
      topology: "hierarchical",
      max_agents: 3,
      instructions:
        "Start with the debugger: nothing is fixed until the cause is named.\nThen one coder makes the smallest fix, and the tester proves it with a test that failed before.\n",
      agents: {
        debugger: {
          description: "Reproduces the bug and names its root cause.",
          model: "opus",
          disallowed_tools: [...READ_ONLY],
          memory_tags: ["decision", "constraint"],
          prompt:
            'Reproduce the failure first. Use em_history to see what changed around the code and em_graph_impact to see who depends on it.\nPost the root cause under the blackboard key "cause": the file and line, why it fails, and the smallest fix.',
        },
        coder: {
          description: "Applies the smallest fix for the named cause.",
          prompt:
            'Read the "cause" note first: em_swarm {action:"read", key:"cause"}.\nFix that cause and nothing else, and run the tests around it.',
        },
        tester: {
          description: "Writes a regression test that fails without the fix and passes with it.",
          prompt:
            "Write the test from the bug report, confirm it fails on the unfixed code, then confirm it passes.\nReport exact failures. Never weaken a test to make it pass.",
        },
      },
    },
  },
  {
    id: "docs",
    name: "Docs pipeline",
    description: "Write a document, edit it, then check it against the code.",
    useWhen: "A change needs documentation and each pass should build on the last.",
    swarm: {
      description: "Write a document, edit it, then check it against the code.",
      topology: "pipeline",
      max_agents: 3,
      stages: ["writer", "editor", "checker"],
      agents: {
        writer: {
          description: "Drafts the document from the code and the design notes.",
          prompt:
            'Draft the document the task asks for. Read the code it describes before writing about it.\nPost the draft under the blackboard key "draft".',
        },
        editor: {
          description: "Tightens the draft for clarity, order and tone.",
          prompt:
            'Read the "draft" note and improve it: cut filler, fix the order, keep every fact.\nPost the result under the key "edited".',
        },
        checker: {
          description: "Checks every claim in the document against the code.",
          disallowed_tools: [...READ_ONLY],
          prompt:
            'Read the "edited" note. For each claim, open the code it describes and confirm it.\nPost the claims that are wrong or unverifiable under the key "corrections".',
        },
      },
    },
  },
  {
    id: "blank",
    name: "Blank",
    description: "One worker to start from.",
    useWhen: "None of the above fits and you want to build the team yourself.",
    swarm: {
      description: "Describe what this swarm is for.",
      topology: "hierarchical",
      max_agents: 2,
      agents: {
        worker: {
          description: "Describe what this worker does.",
          prompt: "Describe how this worker should do its job.",
        },
      },
    },
  },
];

export function getTemplate(id: string): SwarmTemplate | undefined {
  return SWARM_TEMPLATES.find((t) => t.id === id);
}

/** A fresh copy of a template's swarm, safe to edit into a draft. */
export function instantiateTemplate(id: string): SwarmDocSwarm | undefined {
  const t = getTemplate(id);
  return t ? (structuredClone(t.swarm) as SwarmDocSwarm) : undefined;
}
