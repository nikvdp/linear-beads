/**
 * GraphQL client for Linear API
 */

import { GraphQLClient } from "graphql-request";
import { getApiKey } from "./config.js";

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

let client: GraphQLClient | null = null;

/**
 * Get GraphQL client singleton
 */
export function getGraphQLClient(): GraphQLClient {
  if (!client) {
    const apiKey = getApiKey();
    client = new GraphQLClient(LINEAR_ENDPOINT, {
      headers: {
        Authorization: apiKey,
      },
    });
  }
  return client;
}

/**
 * Reset client (useful for testing or key changes)
 */
export function resetGraphQLClient(): void {
  client = null;
}

// Common GraphQL fragments
export const ISSUE_FRAGMENT = `
  id
  identifier
  title
  description
  priority
  createdAt
  updatedAt
  completedAt
  canceledAt
  state {
    id
    name
    type
  }
  labels {
    nodes {
      id
      name
    }
  }
  assignee {
    id
    email
    name
  }
  parent {
    id
    identifier
  }
`;

export const ISSUE_WITH_RELATIONS_FRAGMENT = `
  ${ISSUE_FRAGMENT}
  children {
    nodes {
      id
      identifier
    }
  }
  relations {
    nodes {
      id
      type
      relatedIssue {
        id
        identifier
      }
    }
  }
`;
