const _ = require('underscore');
const lodashGet = require('lodash/get');
const core = require('@actions/core');
const {GitHub, getOctokitOptions} = require('@actions/github/lib/utils');
const {throttling} = require('@octokit/plugin-throttling');
const {paginateRest} = require('@octokit/plugin-paginate-rest');
const CONST = require('./CONST');

const GITHUB_BASE_URL_REGEX = new RegExp('https?://(?:github\\.com|api\\.github\\.com)');
const PULL_REQUEST_REGEX = new RegExp(`${GITHUB_BASE_URL_REGEX.source}/.*/.*/pull/([0-9]+).*`);
const ISSUE_REGEX = new RegExp(`${GITHUB_BASE_URL_REGEX.source}/.*/.*/issues/([0-9]+).*`);
const ISSUE_OR_PULL_REQUEST_REGEX = new RegExp(`${GITHUB_BASE_URL_REGEX.source}/.*/.*/(?:pull|issues)/([0-9]+).*`);

/**
 * The standard rate in ms at which we'll poll the GitHub API to check for status changes.
 * It's 10 seconds :)
 * @type {number}
 */
const POLL_RATE = 10000;

class GithubUtils {
    /**
     * Initialize internal octokit
     *
     * @private
     */
    static initOctokit() {
        const Octokit = GitHub.plugin(throttling, paginateRest);
        const token = core.getInput('GITHUB_TOKEN', {required: true});

        // Save a copy of octokit used in this class
        this.internalOctokit = new Octokit(
            getOctokitOptions(token, {
                throttle: {
                    retryAfterBaseValue: 2000,
                    onRateLimit: (retryAfter, options) => {
                        console.warn(`Request quota exhausted for request ${options.method} ${options.url}`);

                        // Retry five times when hitting a rate limit error, then give up
                        if (options.request.retryCount <= 5) {
                            console.log(`Retrying after ${retryAfter} seconds!`);
                            return true;
                        }
                    },
                    onAbuseLimit: (retryAfter, options) => {
                        // does not retry, only logs a warning
                        console.warn(`Abuse detected for request ${options.method} ${options.url}`);
                    },
                },
            }),
        );
    }

    /**
     * Either give an existing instance of Octokit rest or create a new one
     *
     * @readonly
     * @static
     * @memberof GithubUtils
     */
    static get octokit() {
        if (this.internalOctokit) {
            return this.internalOctokit.rest;
        }
        this.initOctokit();
        return this.internalOctokit.rest;
    }

    /**
     * Get the graphql instance from internal octokit.
     * @readonly
     * @static
     * @memberof GithubUtils
     */
    static get graphql() {
        if (this.internalOctokit) {
            return this.internalOctokit.graphql;
        }
        this.initOctokit();
        return this.internalOctokit.graphql;
    }

    /**
     * Either give an existing instance of Octokit paginate or create a new one
     *
     * @readonly
     * @static
     * @memberof GithubUtils
     */
    static get paginate() {
        if (this.internalOctokit) {
            return this.internalOctokit.paginate;
        }
        this.initOctokit();
        return this.internalOctokit.paginate;
    }

    /**
     * Finds one open `StagingDeployCash` issue via GitHub octokit library.
     *
     * @returns {Promise}
     */
    static getStagingDeployCash() {
        return this.octokit.issues
            .listForRepo({
                owner: CONST.GITHUB_OWNER,
                repo: CONST.APP_REPO,
                labels: CONST.LABELS.STAGING_DEPLOY,
                state: 'open',
            })
            .then(({data}) => {
                if (!data.length) {
                    const error = new Error(`Unable to find ${CONST.LABELS.STAGING_DEPLOY} issue.`);
                    error.code = 404;
                    throw error;
                }

                if (data.length > 1) {
                    const error = new Error(`Found more than one ${CONST.LABELS.STAGING_DEPLOY} issue.`);
                    error.code = 500;
                    throw error;
                }

                return this.getStagingDeployCashData(data[0]);
            });
    }

    /**
     * Takes in a GitHub issue object and returns the data we want.
     *
     * @param {Object} issue
     * @returns {Object}
     */
    static getStagingDeployCashData(issue) {
        try {
            const versionRegex = new RegExp('([0-9]+)\\.([0-9]+)\\.([0-9]+)(?:-([0-9]+))?', 'g');
            const tag = issue.body.match(versionRegex)[0].replace(/`/g, '');
            return {
                title: issue.title,
                url: issue.url,
                number: this.getIssueOrPullRequestNumberFromURL(issue.url),
                labels: issue.labels,
                PRList: this.getStagingDeployCashPRList(issue),
                deployBlockers: this.getStagingDeployCashDeployBlockers(issue),
                internalQAPRList: this.getStagingDeployCashInternalQA(issue),
                isTimingDashboardChecked: /-\s\[x]\sI checked the \[App Timing Dashboard]/.test(issue.body),
                isFirebaseChecked: /-\s\[x]\sI checked \[Firebase Crashlytics]/.test(issue.body),
                isGHStatusChecked: /-\s\[x]\sI checked \[GitHub Status]/.test(issue.body),
                tag,
            };
        } catch (exception) {
            throw new Error(`Unable to find ${CONST.LABELS.STAGING_DEPLOY} issue with correct data.`);
        }
    }

    /**
     * Parse the PRList and Internal QA section of the StagingDeployCash issue body.
     *
     * @private
     *
     * @param {Object} issue
     * @returns {Array<Object>} - [{url: String, number: Number, isVerified: Boolean}]
     */
    static getStagingDeployCashPRList(issue) {
        let PRListSection = issue.body.match(/pull requests:\*\*\r?\n((?:-.*\r?\n)+)\r?\n\r?\n?/) || [];
        if (PRListSection.length !== 2) {
            // No PRs, return an empty array
            console.log('Hmmm...The open StagingDeployCash does not list any pull requests, continuing...');
            return [];
        }
        PRListSection = PRListSection[1];
        const PRList = _.map([...PRListSection.matchAll(new RegExp(`- \\[([ x])] (${PULL_REQUEST_REGEX.source})`, 'g'))], (match) => ({
            url: match[2],
            number: Number.parseInt(match[3], 10),
            isVerified: match[1] === 'x',
        }));
        return _.sortBy(PRList, 'number');
    }

    /**
     * Parse DeployBlocker section of the StagingDeployCash issue body.
     *
     * @private
     *
     * @param {Object} issue
     * @returns {Array<Object>} - [{URL: String, number: Number, isResolved: Boolean}]
     */
    static getStagingDeployCashDeployBlockers(issue) {
        let deployBlockerSection = issue.body.match(/Deploy Blockers:\*\*\r?\n((?:-.*\r?\n)+)/) || [];
        if (deployBlockerSection.length !== 2) {
            return [];
        }
        deployBlockerSection = deployBlockerSection[1];
        const deployBlockers = _.map([...deployBlockerSection.matchAll(new RegExp(`- \\[([ x])]\\s(${ISSUE_OR_PULL_REQUEST_REGEX.source})`, 'g'))], (match) => ({
            url: match[2],
            number: Number.parseInt(match[3], 10),
            isResolved: match[1] === 'x',
        }));
        return _.sortBy(deployBlockers, 'number');
    }

    /**
     * Parse InternalQA section of the StagingDeployCash issue body.
     *
     * @private
     *
     * @param {Object} issue
     * @returns {Array<Object>} - [{URL: String, number: Number, isResolved: Boolean}]
     */
    static getStagingDeployCashInternalQA(issue) {
        let internalQASection = issue.body.match(/Internal QA:\*\*\r?\n((?:- \[[ x]].*\r?\n)+)/) || [];
        if (internalQASection.length !== 2) {
            return [];
        }
        internalQASection = internalQASection[1];
        const internalQAPRs = _.map([...internalQASection.matchAll(new RegExp(`- \\[([ x])]\\s(${PULL_REQUEST_REGEX.source})`, 'g'))], (match) => ({
            url: match[2].split('-')[0].trim(),
            number: Number.parseInt(match[3], 10),
            isResolved: match[1] === 'x',
        }));
        return _.sortBy(internalQAPRs, 'number');
    }

    /**
     * Generate the issue body for a StagingDeployCash.
     *
     * @param {String} tag
     * @param {Array} PRList - The list of PR URLs which are included in this StagingDeployCash
     * @param {Array} [verifiedPRList] - The list of PR URLs which have passed QA.
     * @param {Array} [deployBlockers] - The list of DeployBlocker URLs.
     * @param {Array} [resolvedDeployBlockers] - The list of DeployBlockers URLs which have been resolved.
     * @param {Array} [resolvedInternalQAPRs] - The list of Internal QA PR URLs which have been resolved.
     * @param {Boolean} [isTimingDashboardChecked]
     * @param {Boolean} [isFirebaseChecked]
     * @param {Boolean} [isGHStatusChecked]
     * @returns {Promise}
     */
    static generateStagingDeployCashBody(
        tag,
        PRList,
        verifiedPRList = [],
        deployBlockers = [],
        resolvedDeployBlockers = [],
        resolvedInternalQAPRs = [],
        isTimingDashboardChecked = false,
        isFirebaseChecked = false,
        isGHStatusChecked = false,
    ) {
        return this.fetchAllPullRequests(_.map(PRList, this.getPullRequestNumberFromURL))
            .then((data) => {
                // The format of this map is following:
                // {
                //    'https://github.com/Expensify/App/pull/9641': 'PauloGasparSv',
                //    'https://github.com/Expensify/App/pull/9642': 'mountiny'
                // }
                const internalQAPRMap = _.reduce(
                    _.filter(data, (pr) => !_.isEmpty(_.findWhere(pr.labels, {name: CONST.LABELS.INTERNAL_QA}))),
                    (map, pr) => {
                        // eslint-disable-next-line no-param-reassign
                        map[pr.html_url] = pr.merged_by.login;
                        return map;
                    },
                    {},
                );
                console.log('Found the following Internal QA PRs:', internalQAPRMap);

                const noQAPRs = _.pluck(
                    _.filter(data, (PR) => /\[No\s?QA]/i.test(PR.title)),
                    'html_url',
                );
                console.log('Found the following NO QA PRs:', noQAPRs);
                const verifiedOrNoQAPRs = _.union(verifiedPRList, noQAPRs);

                const sortedPRList = _.chain(PRList).difference(_.keys(internalQAPRMap)).unique().sortBy(GithubUtils.getPullRequestNumberFromURL).value();
                const sortedDeployBlockers = _.sortBy(_.unique(deployBlockers), GithubUtils.getIssueOrPullRequestNumberFromURL);

                // Tag version and comparison URL
                // eslint-disable-next-line max-len
                let issueBody = `**Release Version:** \`${tag}\`\r\n**Compare Changes:** https://github.com/Expensify/App/compare/production...staging\r\n`;

                // PR list
                if (!_.isEmpty(sortedPRList)) {
                    issueBody += '\r\n**This release contains changes from the following pull requests:**\r\n';
                    _.each(sortedPRList, (URL) => {
                        issueBody += _.contains(verifiedOrNoQAPRs, URL) ? '- [x]' : '- [ ]';
                        issueBody += ` ${URL}\r\n`;
                    });
                    issueBody += '\r\n\r\n';
                }

                // Internal QA PR list
                if (!_.isEmpty(internalQAPRMap)) {
                    console.log('Found the following verified Internal QA PRs:', resolvedInternalQAPRs);
                    issueBody += '**Internal QA:**\r\n';
                    _.each(internalQAPRMap, (merger, URL) => {
                        const mergerMention = `@${merger}`;
                        issueBody += `${_.contains(resolvedInternalQAPRs, URL) ? '- [x]' : '- [ ]'} `;
                        issueBody += `${URL}`;
                        issueBody += ` - ${mergerMention}`;
                        issueBody += '\r\n';
                    });
                    issueBody += '\r\n\r\n';
                }

                // Deploy blockers
                if (!_.isEmpty(deployBlockers)) {
                    issueBody += '**Deploy Blockers:**\r\n';
                    _.each(sortedDeployBlockers, (URL) => {
                        issueBody += _.contains(resolvedDeployBlockers, URL) ? '- [x] ' : '- [ ] ';
                        issueBody += URL;
                        issueBody += '\r\n';
                    });
                    issueBody += '\r\n\r\n';
                }

                issueBody += '**Deployer verifications:**';
                // eslint-disable-next-line max-len
                issueBody += `\r\n- [${
                    isTimingDashboardChecked ? 'x' : ' '
                }] I checked the [App Timing Dashboard](https://graphs.expensify.com/grafana/d/yj2EobAGz/app-timing?orgId=1) and verified this release does not cause a noticeable performance regression.`;
                // eslint-disable-next-line max-len
                issueBody += `\r\n- [${
                    isFirebaseChecked ? 'x' : ' '
                }] I checked [Firebase Crashlytics](https://console.firebase.google.com/u/0/project/expensify-chat/crashlytics/app/android:com.expensify.chat/issues?state=open&time=last-seven-days&tag=all) and verified that this release does not introduce any new crashes. More detailed instructions on this verification can be found [here](https://stackoverflowteams.com/c/expensify/questions/15095/15096).`;
                // eslint-disable-next-line max-len
                issueBody += `\r\n- [${isGHStatusChecked ? 'x' : ' '}] I checked [GitHub Status](https://www.githubstatus.com/) and verified there is no reported incident with Actions.`;

                issueBody += '\r\n\r\ncc @Expensify/applauseleads\r\n';
                const issueAssignees = _.values(internalQAPRMap);
                const issue = {issueBody, issueAssignees};
                return issue;
            })
            .catch((err) => console.warn('Error generating StagingDeployCash issue body! Continuing...', err));
    }

    /**
     * Fetch all pull requests given a list of PR numbers.
     *
     * @param {Array<Number>} pullRequestNumbers
     * @returns {Promise}
     */
    static fetchAllPullRequests(pullRequestNumbers) {
        const oldestPR = _.first(_.sortBy(pullRequestNumbers));
        return this.paginate(
            this.octokit.pulls.list,
            {
                owner: CONST.GITHUB_OWNER,
                repo: CONST.APP_REPO,
                state: 'all',
                sort: 'created',
                direction: 'desc',
                per_page: 100,
            },
            ({data}, done) => {
                if (_.find(data, (pr) => pr.number === oldestPR)) {
                    done();
                }
                return data;
            },
        )
            .then((prList) => _.filter(prList, (pr) => _.contains(pullRequestNumbers, pr.number)))
            .catch((err) => console.error('Failed to get PR list', err));
    }

    /**
     * @param {Number} pullRequestNumber
     * @returns {Promise}
     */
    static getPullRequestBody(pullRequestNumber) {
        return this.octokit.pulls
            .get({
                owner: CONST.GITHUB_OWNER,
                repo: CONST.APP_REPO,
                pull_number: pullRequestNumber,
            })
            .then(({data: pullRequestComment}) => pullRequestComment.body);
    }

    /**
     * @param {Number} pullRequestNumber
     * @returns {Promise}
     */
    static getAllReviewComments(pullRequestNumber) {
        return this.paginate(
            this.octokit.pulls.listReviews,
            {
                owner: CONST.GITHUB_OWNER,
                repo: CONST.APP_REPO,
                pull_number: pullRequestNumber,
                per_page: 100,
            },
            (response) => _.map(response.data, (review) => review.body),
        );
    }

    /**
     * @param {Number} issueNumber
     * @returns {Promise}
     */
    static getAllComments(issueNumber) {
        return this.paginate(
            this.octokit.issues.listComments,
            {
                owner: CONST.GITHUB_OWNER,
                repo: CONST.APP_REPO,
                issue_number: issueNumber,
                per_page: 100,
            },
            (response) => _.map(response.data, (comment) => comment.body),
        );
    }

    /**
     * Create comment on pull request
     *
     * @param {String} repo - The repo to search for a matching pull request or issue number
     * @param {Number} number - The pull request or issue number
     * @param {String} messageBody - The comment message
     * @returns {Promise}
     */
    static createComment(repo, number, messageBody) {
        console.log(`Writing comment on #${number}`);
        return this.octokit.issues.createComment({
            owner: CONST.GITHUB_OWNER,
            repo,
            issue_number: number,
            body: messageBody,
        });
    }

    /**
     * Get the most recent workflow run for the given New Expensify workflow.
     *
     * @param {String} workflow
     * @returns {Promise}
     */
    static getLatestWorkflowRunID(workflow) {
        console.log(`Fetching New Expensify workflow runs for ${workflow}...`);
        return this.octokit.actions
            .listWorkflowRuns({
                owner: CONST.GITHUB_OWNER,
                repo: CONST.APP_REPO,
                workflow_id: workflow,
            })
            .then((response) => lodashGet(response, 'data.workflow_runs[0].id'));
    }

    /**
     * Generate the well-formatted body of a production release.
     *
     * @param {Array<Number>} pullRequests
     * @returns {String}
     */
    static getReleaseBody(pullRequests) {
        return _.map(pullRequests, (number) => `- ${this.getPullRequestURLFromNumber(number)}`).join('\r\n');
    }

    /**
     * Generate the URL of an New Expensify pull request given the PR number.
     *
     * @param {Number} number
     * @returns {String}
     */
    static getPullRequestURLFromNumber(number) {
        return `${CONST.APP_REPO_URL}/pull/${number}`;
    }

    /**
     * Parse the pull request number from a URL.
     *
     * @param {String} URL
     * @returns {Number}
     * @throws {Error} If the URL is not a valid Github Pull Request.
     */
    static getPullRequestNumberFromURL(URL) {
        const matches = URL.match(PULL_REQUEST_REGEX);
        if (!_.isArray(matches) || matches.length !== 2) {
            throw new Error(`Provided URL ${URL} is not a Github Pull Request!`);
        }
        return Number.parseInt(matches[1], 10);
    }

    /**
     * Parse the issue number from a URL.
     *
     * @param {String} URL
     * @returns {Number}
     * @throws {Error} If the URL is not a valid Github Issue.
     */
    static getIssueNumberFromURL(URL) {
        const matches = URL.match(ISSUE_REGEX);
        if (!_.isArray(matches) || matches.length !== 2) {
            throw new Error(`Provided URL ${URL} is not a Github Issue!`);
        }
        return Number.parseInt(matches[1], 10);
    }

    /**
     * Parse the issue or pull request number from a URL.
     *
     * @param {String} URL
     * @returns {Number}
     * @throws {Error} If the URL is not a valid Github Issue or Pull Request.
     */
    static getIssueOrPullRequestNumberFromURL(URL) {
        const matches = URL.match(ISSUE_OR_PULL_REQUEST_REGEX);
        if (!_.isArray(matches) || matches.length !== 2) {
            throw new Error(`Provided URL ${URL} is not a valid Github Issue or Pull Request!`);
        }
        return Number.parseInt(matches[1], 10);
    }

    /**
     * Return the login of the actor who closed an issue or PR. If the issue is not closed, return an empty string.
     *
     * @param {Number} issueNumber
     * @returns {Promise<String>}
     */
    static getActorWhoClosedIssue(issueNumber) {
        return this.paginate(this.octokit.issues.listEvents, {
            owner: CONST.GITHUB_OWNER,
            repo: CONST.APP_REPO,
            issue_number: issueNumber,
            per_page: 100,
        })
            .then((events) => _.filter(events, (event) => event.event === 'closed'))
            .then((closedEvents) => lodashGet(_.last(closedEvents), 'actor.login', ''));
    }

    static getArtifactByName(artefactName) {
        return this.paginate(this.octokit.actions.listArtifactsForRepo, {
            owner: CONST.GITHUB_OWNER,
            repo: CONST.APP_REPO,
            per_page: 100,
        }).then((artifacts) => _.findWhere(artifacts, {name: artefactName}));
    }
}

module.exports = GithubUtils;
module.exports.ISSUE_OR_PULL_REQUEST_REGEX = ISSUE_OR_PULL_REQUEST_REGEX;
module.exports.POLL_RATE = POLL_RATE;
