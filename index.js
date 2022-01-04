const { Toolkit } = require('actions-toolkit');
const { graphql } = require('@octokit/graphql');
const fetch = require('node-fetch');

(async function() {
    const tools = new Toolkit({
        event: ['deployment_status'],
        secrets: ['GITHUB_TOKEN', 'HEROKU_AUTH_TOKEN'],
        token: process.env.GITHUB_TOKEN
    });

    // Only continue if deployment was a failure
    const deployState = tools.context.payload.deployment_status.state;
    if (deployState !== 'failure') {
        tools.exit.success(`Deploy was not a failure. Got '${deployState}'`);
    }

    const repoOwner = tools.context.payload.repository.owner.login;
    const repoName = tools.context.payload.repository.name;
    const appName = tools.context.payload.deployment.environment;

    // Fetch number of PR associated with this deployment
    const prNum = await fetchPRNumber(
      repoOwner,
      repoName,
      tools.context.sha
    );

    // Fetch the latest build
    let build = await loadHerokuBuild(appName);

    // And the logs for that build (URL contains auth)
    let logResponse = await fetch(build.output_stream_url);
    const logText = await logResponse.text();

    // Leave comment with build error message on PR
    const msgBody = "### ⚠️ **Heroku Deployment Failed** ⚠️ \n" + "```\n" + logText + "\n```"

    const reviewCommentDetails = {
      owner: repoOwner,
      repo: repoName,
      issue_number: prNum,
      body: msgBody
    };

    await tools.github.issues.createComment(reviewCommentDetails);

    tools.exit.success('Logs posted');
})();

async function fetchPRNumber(owner, repoName, commitSha) {
  const prQuery = await graphql({
    query: `query ($owner: String!, $repoName: String!, $commitSha: GitObjectID!) {
      repository(owner: $owner, name: $repoName) {
          object(oid: $commitSha) {
            ... on Commit {
              associatedPullRequests (last: 1) {
                edges {
                  node {
                    number
                  }
                }
              }
            }
          }
        }
      }
    `,
    owner,
    repoName,
    commitSha,
    headers: {
      authorization: `token ${process.env.GITHUB_TOKEN}`,
    },
  });

  const prNum = prQuery.repository.object.associatedPullRequests.edges[0].node.number;

  return prNum;
}

async function loadHerokuBuild(repoName) {
    const resp = await fetch(`https://api.heroku.com/apps/${repoName}/builds`, {
      method: 'GET',
      headers: {
          Authorization: `Bearer ${process.env.HEROKU_AUTH_TOKEN}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': "application/json; charset=UTF-8",
          Range: 'created_at; order=desc, max=1;'
      }
    });

    const firstBuild = (await resp.json())[0];
    return firstBuild;
}
