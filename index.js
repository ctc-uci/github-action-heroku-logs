const { Toolkit } = require('actions-toolkit');
const { graphql } = require('@octokit/graphql');
const fetch = require('node-fetch');

(async function() {
    const tools = new Toolkit({
        event: ['deployment_status'],
        secrets: ['AUTH_TOKEN', 'DEVOPS_PAT_TOKEN', 'HEROKU_AUTH_TOKEN'],
        token: process.env.AUTH_TOKEN
    });

    console.log(tools.context);

    // Only continue if this was a failure
    const deployState = tools.context.payload.deployment_status.state;
    if (deployState !== 'failure') {
        tools.exit.neutral(`Deploy was not a failure. Got '${deployState}'`);
    }

    console.log(`### DEPLOY STATE: ${deployState}`);

    const repoName = tools.context.payload.repository.name;
    const appName = tools.context.payload.deployment.environment;

    // TODO: use sha or ref to get PR number
    // See: https://stackoverflow.com/questions/66092415/get-corresponding-pr-from-github-deployment-status-webhook
    // https://docs.github.com/en/rest/reference/commits#list-pull-requests-associated-with-a-commit

    const { prNum } = await graphql({
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
      owner: tools.context.payload.repository.owner.login,
      commitSha: tools.context.sha,
      repoName: repoName,
      headers: {
        authorization: `token ${process.env.AUTH_TOKEN}`,
      },
    });

    console.log('### PR Query result ###');
    console.log(prNum);

    // const prs = await tools.github.repos.listPullRequestsAssociatedWithCommit({
    //     owner: tools.context.payload.repository.owner.login,
    //     repo: repoName,
    //     commit_sha: tools.context.sha
    // });

    // console.log('### PR Query result ###');
    // console.log(prs);

    const pullNumber = -1;

    // Fetch the latest build
    let build = await loadHerokuBuild(appName);

    // And the logs for that build (URL contains auth)
    let logResponse = await fetch(build.output_stream_url);
    const logText = await logResponse.text();

    const msgBody = "⚠️ Heroku Deployment Failed ⚠️ \n" + "```\n" + logText + "\n```"

    const reviewCommentDetails = {
        owner: tools.context.payload.repository.owner.login,
        repo: repoName,
        pull_number: pullNumber,
        body: msgBody
    };

    await tools.github.pulls.createReviewComment(reviewCommentDetails);

    tools.exit.success("Logs posted");
})();

async function loadHerokuBuild(repoName) {
    const resp = await fetch(`https://api.heroku.com/apps/${repoName}/builds`, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${process.env.HEROKU_AUTH_TOKEN}`,
            Accept: 'application/vnd.heroku+json; version=3',
            "Content-Type": "application/json; charset=UTF-8",
            Range: 'created_at; order=desc, max=1;'
        }
    });

    const firstBuild = (await resp.json())[0];
    return firstBuild;
}
