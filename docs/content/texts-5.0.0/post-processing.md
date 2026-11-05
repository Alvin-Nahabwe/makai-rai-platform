# The post-processing texts of content 5.0.0

23 questions, in the order S-12 shows them.

## Q-PO-01

**Question:** Have you established continuous monitoring for model performance degradation and data drift?

| Text | Wording |
|---|---|
| Expected practice | Once the system is in use, a named person checks on a set schedule whether its inputs and its performance have moved away from what it was tested on. The checks, their thresholds and who acts when a threshold is crossed are written down. |
| Why this is asked | Data changes with seasons, new clinics, new phones and new policies, and a model nobody watches gets worse unnoticed, often until it harms the people it serves. Risk area: Deployment Drift. |
| Reason prompt | Say what is checked, how often, the thresholds, and who acts, by role. This text is printed in the model card under "Monitoring requirements and retraining triggers". If the system is not deployed yet, choose "not yet"; choose "not applicable" only if it will never be used outside the study. |
| Evidence example 1 | the monitoring plan |
| Evidence example 2 | a link to the dashboard or check script |
| Evidence example 3 | the C-21 notebook summary used to set thresholds |
| Help text | Model performance naturally degrades as real-world data distributions evolve over time. |
| Example | Track whether prediction accuracy changes over time as the population or environment the model serves shifts. |

## Q-PO-02

**Question:** Have you defined triggers and procedures for model retraining?

| Text | Wording |
|---|---|
| Expected practice | The team wrote down what triggers retraining, such as a monitored measure crossing a threshold the team set, a change in the population served or a set date. It also wrote down the steps to retrain and check the new model, and who decides, by role. |
| Why this is asked | Without agreed triggers and written steps, a model keeps running after it stops working well, or is retrained and put in use without checks. Risk area: Deployment Drift. |
| Reason prompt | Name the triggers and the thresholds you set, then the steps and who decides, by role. This text is printed in the model card under "Monitoring requirements and retraining triggers". If the system is not deployed yet, choose "not yet". |
| Evidence example 1 | the retraining procedure |
| Evidence example 2 | the monitoring plan with its thresholds |
| Evidence example 3 | the record of a past retraining |
| Help text | Without clear retraining criteria, models may continue operating long after their predictions become unreliable. |
| Example | Set a rule: retrain the model when monthly accuracy drops below a threshold, or when the input data distribution shifts beyond a defined tolerance. |

## Q-PO-03

**Question:** Is there a human-in-the-loop mechanism for reviewing and overriding AI decisions?

| Text | Wording |
|---|---|
| Expected practice | People who use the system can review each output before it is acted on, or a sample of outputs in proportion to the risk, and can override it. How to override, who may do it, by role, and how overrides are recorded are written down and in use. |
| Why this is asked | A person who can check and override the system catches errors before they harm someone, but only if the way to override is clear and people use it. Risk area: Lack of Human Oversight. |
| Reason prompt | Describe who reviews outputs, by role, when, and how they override them. Say how overrides are recorded and how often they happen. |
| Evidence example 1 | the workflow showing the review step |
| Evidence example 2 | a log or summary of overrides |
| Evidence example 3 | the user guide section on overriding |
| Help text | Human oversight makes sure AI decisions can be reviewed, corrected, and placed in context by someone with relevant expertise. |
| Example | Can a domain expert override the model's recommendation? Is there a clear, documented workflow for doing so? |

## Q-PO-04

**Question:** Have you defined clear roles and responsibilities for AI system outcomes (accountability matrix)?

| Text | Wording |
|---|---|
| Expected practice | The team wrote down who is responsible, by role and organisation, for each part of the system's outcomes. The parts include deciding to deploy it, monitoring it, responding to harm, fixing errors and deciding to stop it. The people in those roles have agreed. |
| Why this is asked | When several organisations share a system, harms can go unaddressed because each thinks another is responsible, and named roles make clear who acts. Risk area: Accountability Gap. |
| Reason prompt | List the responsibilities and who holds each, by role and organisation, never by name. Say how the roles were agreed. |
| Evidence example 1 | a governance and accountability matrix (C-26) |
| Evidence example 2 | a memorandum of understanding naming the roles |
| Evidence example 3 | minutes of the meeting where the roles were agreed |
| Help text | Without clear accountability, harmful outcomes may go unaddressed and no one takes responsibility for corrective action. |
| Example | If the AI system makes a harmful decision, who is responsible? The deploying organization, the model developer, or the data provider? Define this upfront. |

## Q-PO-05

**Question:** Have you created an incident response plan for when the AI system produces harmful outputs?

| Text | Wording |
|---|---|
| Expected practice | The team has a written plan for when the system causes or may cause harm. It says how a problem is reported, who is alerted, by role, and how the system is paused or limited. It also says how the people affected are told and helped, and how the cause is found and fixed. |
| Why this is asked | Harm from a system in use needs a fast response, which planning in the moment cannot give, and a written plan shows the people affected that problems are taken seriously. Risk areas: Lack of Human Oversight and Accountability Gap. |
| Reason prompt | Describe how a harmful output is reported and what happens next, naming roles, not people. Say whether the plan has been tried in an exercise or used. |
| Evidence example 1 | the incident response plan |
| Evidence example 2 | the record of an exercise or a real incident |
| Evidence example 3 | the contact route shown to users |
| Help text | Incident response plans ensure rapid, coordinated action when things go wrong. |
| Example | If the model starts producing systematically wrong predictions for a specific group, who gets alerted and what steps follow? |

## Q-PO-06

**Question:** Have you provided training or educational resources for end-users of the AI system?

| Text | Wording |
|---|---|
| Expected practice | The people who use the system's outputs were given training or guidance, in a language and form that suits them. It covered what the outputs mean, how far to trust them, when not to rely on them and how to report a problem. |
| Why this is asked | Users who do not understand a system either trust it too much or ignore it, and short, practical training is often the cheapest safeguard. Risk area: User Literacy Deficit. |
| Reason prompt | Say who was trained, by role, how, and in which languages. Say how you checked that the training worked. |
| Evidence example 1 | the training materials or user guide |
| Evidence example 2 | a record of the training sessions, by role and number |
| Evidence example 3 | feedback from trained users |
| Help text | Users who don't understand the AI system may over-rely on it or dismiss its outputs inappropriately. |
| Example | Village health teams were shown, in Luganda, what a 'refer' flag on the phone means, when to refer anyway and how to report a result that looks wrong. |

## Q-PO-07

**Question:** Can end-users understand the AI system's outputs, confidence levels, and limitations?

| Text | Wording |
|---|---|
| Expected practice | The system shows users each output with how confident it is and the main limits that apply, in words they understand, and the team checked that users read them correctly. In proportion to the risk, where an output is about a person, the user can see the main reasons for it. Telling stakeholders the limits in general is Q-PO-15. |
| Why this is asked | An output that users misread is as harmful as a wrong one, and seeing the confidence and the reasons lets a user decide when to question the system. Risk areas: Lack of Human Oversight and User Literacy Deficit. |
| Reason prompt | Describe what users see with each output, and how you checked that they read it correctly. Say whether outputs about a person show the main reasons for them. |
| Evidence example 1 | screenshots of the output screen |
| Evidence example 2 | results of testing with users |
| Evidence example 3 | the user guide section on reading outputs |
| Help text | Transparent communication of model capabilities and limitations prevents misuse and builds appropriate trust. |
| Example | Show confidence intervals alongside predictions. Clearly state what populations or conditions the model was not designed for. |

## Q-PO-16

**Question:** Have you implemented A/B testing or staged rollout procedures for model deployment?

| Text | Wording |
|---|---|
| Expected practice | The team introduced the system in stages, for example at one site or with one group first, and compared outcomes with the existing practice before expanding. It wrote down the measures and the result needed to go further. |
| Why this is asked | Problems that testing missed show up in real use, and starting small limits who is affected while they are found. Risk area: Deployment Drift. |
| Reason prompt | Describe the stages, the sites by type and what you compared. Say what result you set for expanding and whether it was reached. |
| Evidence example 1 | the rollout plan |
| Evidence example 2 | results from the first site |
| Evidence example 3 | the decision note to expand or to stop |
| Help text | Staged rollouts limit how many people are affected if something goes wrong, and test the system in real use before full release. |
| Example | Deploy the new model in one site first, compare outcomes with the existing system, then expand gradually if results hold up. |

## Q-PO-17

**Question:** Have you established monitoring for fairness metrics in production, not just accuracy?

| Text | Wording |
|---|---|
| Expected practice | Once the system is in use, a person in a set role checks on a schedule whether results for each group that matters stay within the team's thresholds. The groups, the measures, the checks and who acts when a threshold is crossed are written down. |
| Why this is asked | Fairness can get worse in use even when overall accuracy holds, because the people served change, and only results per group show it. Risk areas: Deployment Drift and Feedback Loop Absence. |
| Reason prompt | Say which groups and measures are checked, how often, the thresholds and who acts, by role. If the system is not deployed yet, choose "not yet". |
| Evidence example 1 | the monitoring plan with its group measures |
| Evidence example 2 | a link to the monitoring dashboard |
| Evidence example 3 | a monitoring report by group |
| Help text | Fairness can degrade in production even when accuracy remains stable, if the demographic composition of served populations shifts. |
| Example | Monitor whether false negative rates for different demographic groups remain balanced as the model encounters new populations in production. |

## Q-PO-18

**Question:** Have you defined performance thresholds below which the system should be automatically disabled or flagged?

| Text | Wording |
|---|---|
| Expected practice | The team set its own thresholds at which the system is flagged for review or stopped. It wrote down how that happens, automatically or by a person in a set role, and how decisions are made while the system is stopped. |
| Why this is asked | A system that keeps running after it has degraded can harm many people before anyone acts, and a set threshold makes the decision quick and clear. Risk areas: Deployment Drift and Lack of Human Oversight. |
| Reason prompt | Give the thresholds you set and what happens when each is crossed. Say how decisions are made while the system is stopped. |
| Evidence example 1 | the monitoring plan with the stop thresholds |
| Evidence example 2 | the fallback procedure |
| Evidence example 3 | the alert settings, described or linked |
| Help text | Automatic safeguards prevent continued use of a degraded model that could cause harm. |
| Example | Set an alert when the share of correct predictions in a week drops below the threshold the team chose, and send decisions to human review below a lower one. |

## Q-PO-08

**Question:** Have you established feedback channels for affected communities and end-users?

| Text | Wording |
|---|---|
| Expected practice | Users and the people affected have a way to report problems or concerns that suits them, such as a phone line, SMS or a community meeting. The reports reach a person in a set role, and the team records what it did about them. |
| Why this is asked | People affected by a system often see its problems first, and a channel they can use, with visible action on what they say, keeps the system honest. Risk area: Feedback Loop Absence. |
| Reason prompt | Describe the channels, who receives reports, by role, and how many have come in. Do not upload reports that identify people. |
| Evidence example 1 | a description of the feedback channels |
| Evidence example 2 | a summary of the reports received and the actions taken |
| Evidence example 3 | the notice telling people how to give feedback |
| Help text | Feedback channels enable continuous improvement and help identify real-world issues that weren't anticipated during development. |
| Example | Give end-users a straightforward way to flag cases where the AI's output seems wrong or inappropriate. |

## Q-PO-09

**Question:** Is there a mechanism for individuals affected by AI decisions to contest or appeal those decisions?

| Text | Wording |
|---|---|
| Expected practice | People affected by a decision the system supports are told they can ask for a review, and have a simple way to do so. A person in a set role reviews the case, and the team records the requests and their outcomes. |
| Why this is asked | A person who cannot challenge a decision about them has no remedy for an error, and review by a person catches what the system got wrong. Risk area: Feedback Loop Absence. |
| Reason prompt | Describe how people learn they can ask for a review, how they ask and who reviews, by role. Give the number of requests and outcomes, never personal details. |
| Evidence example 1 | the review procedure |
| Evidence example 2 | the notice to the people affected |
| Evidence example 3 | a summary of requests and outcomes |
| Help text | The right to contest automated decisions is a fundamental principle in many data protection frameworks. |
| Example | A family told by the system that they do not qualify for support should be able to ask a person to look at their case again. |

## Q-PO-10

**Question:** Have you created complete documentation for the deployed system (codebook, deployment specs)?

| Text | Wording |
|---|---|
| Expected practice | The team wrote documentation for the deployed system that someone else could run it from. It covers what the system does, its parts and data flows, and how to install and update it. It also names the infrastructure it needs, for example power, connectivity and devices, its other dependencies and its known limits. |
| Why this is asked | When the person who built a system leaves, the documentation keeps it running safely, and systems in low-resource settings often stop because a dependency was never written down. Risk area: Documentation Deficit. |
| Reason prompt | Say what the documentation covers and where it is kept. Say whether someone outside the build team has used it. |
| Evidence example 1 | the codebook and deployment document (C-28) |
| Evidence example 2 | a link to the documentation in the repository |
| Help text | System documentation lets others run, check and hand over the system, and lets decision-makers judge when to update or retire it. |
| Example | A deployment codebook should describe the system architecture, API endpoints, data flows, update procedures, and known limitations. |

## Q-PO-11

**Question:** Which of the following governance measures are in place?

| Text | Wording |
|---|---|
| Expected practice | The team has the governance measures its setting needs, usually data governance, an ethics review process, logging, version control and access control, and wrote down how each works. A tick on national data protection laws means the team identified the law and holds what it requires. Outside reviews and a community board fit higher-risk systems. |
| Why this is asked | Governance measures keep a system's use responsible after the build team moves on, and which ones fit depends on the risk and the setting. |
| Reason prompt | Tick the measures in place and say how each works, naming bodies and roles, not people. For each unticked measure, say whether it does not fit or is still to do. |
| Evidence example 1 | the terms of reference of the governance or ethics body |
| Evidence example 2 | the access control policy |
| Evidence example 3 | approval letters or registrations, with their references |
| Help text | Governance measures provide the institutional framework for responsible AI deployment and oversight. |
| Example | An ethics review board that reviews AI deployments before they go live, with representation from affected communities. |

## Q-PO-12

**Question:** Have you assessed the AI system's performance across the deployment context's diversity (geographic, linguistic, cultural)?

| Text | Wording |
|---|---|
| Expected practice | The team checked results separately for the places, languages and kinds of user where the system is used, for example districts, dialects, devices or literacy. It wrote down where the system works less well and what it did. |
| Why this is asked | A system tested in one place or language often works worse in another, and users there carry the cost unless someone checks. Risk area: Deployment Drift. |
| Reason prompt | Name the settings you compared and what you found. Say what you changed, or stated as a limit. |
| Evidence example 1 | results by setting |
| Evidence example 2 | notes from field testing at different sites |
| Evidence example 3 | results of testing with users in each language |
| Help text | Models may perform differently across deployment contexts due to cultural, linguistic, or infrastructure differences. |
| Example | A voice tool built on recordings from Kampala may work poorly for speakers of other dialects. A text model trained on formal writing may struggle with messages typed on phones. |

## Q-PO-13

**Question:** Have you planned for the eventual decommissioning or replacement of the AI system?

| Text | Wording |
|---|---|
| Expected practice | The team wrote down when the system should be retired or replaced, for example when the need ends, a better method exists or upkeep costs too much. It also wrote down how: who decides, how users and data are handled, and what replaces it. The plan counts the computing and energy the system uses while running, estimated from hardware hours and power draw. |
| Why this is asked | Systems left running after their purpose ends keep using money and power, and drift without oversight, so planning the end at the start means someone decides when to stop. Risk area: Environmental Impact. |
| Reason prompt | Say what would trigger retirement and who decides, by role. Give your estimate of the computing and energy the system uses while running. |
| Evidence example 1 | the retirement section of the deployment plan |
| Evidence example 2 | the running cost estimate, with energy |
| Help text | All systems have a lifecycle. Planning for end-of-life prevents orphaned systems running without oversight. |
| Example | Define criteria for when the model should be retired, such as when the problem it solves is no longer relevant or when a better approach becomes available. |

## Q-PO-14

**Question:** Is the system designed to gracefully degrade or fail safely when it encounters out-of-distribution inputs?

| Text | Wording |
|---|---|
| Expected practice | The system detects inputs unlike those it was built on, for example by checking value ranges or the model's confidence. It then handles them safely: it flags them, asks a person to decide or falls back to the earlier practice. The team tested this and wrote down how it works. |
| Why this is asked | Every system meets inputs it was not built for, and a safe one flags them for a person to decide instead of giving a confident wrong answer. Risk areas: Deployment Drift, Lack of Human Oversight and Accountability Gap. |
| Reason prompt | Describe how unusual inputs are detected and what the system does then. Say how you tested it. |
| Evidence example 1 | the design note on handling unusual inputs |
| Evidence example 2 | test results with unusual inputs |
| Evidence example 3 | the fallback procedure |
| Help text | Graceful degradation means the system provides safe, useful output even when encountering unexpected inputs. |
| Example | When the model encounters input it wasn't trained on, it should flag uncertainty rather than confidently returning a wrong answer. |

## Q-PO-15

**Question:** Have you communicated the AI system's limitations and intended use to all stakeholders?

| Text | Wording |
|---|---|
| Expected practice | The team told the people who decide on, run or rely on the system what it is for, where it may not be used and its main limits. It did so in writing and in their language, and keeps a record of who was told, by role. How each output is shown to users is Q-PO-07. |
| Why this is asked | Limits that only the build team knows protect nobody, so decision-makers and partners need them in writing before they rely on the system. Risk areas: User Literacy Deficit and Documentation Deficit. |
| Reason prompt | Say who was told, by role or organisation, what and how. This text is printed in the model card under "Deployment recommendations", so state the intended use and the main limits first. |
| Evidence example 1 | the briefing note to partners |
| Evidence example 2 | the model card or its limitations section |
| Evidence example 3 | minutes of the handover meeting |
| Help text | Transparent communication prevents both over-reliance and under-utilization of AI systems. |
| Example | Document clearly that a model validated on one population should not be assumed to work for a different population without separate testing. |

## Q-PO-20

**Question:** Have you involved representatives of affected communities in the design and evaluation of the AI system?

| Text | Wording |
|---|---|
| Expected practice | Representatives of the communities affected took part in designing and evaluating the system, for example through a community advisory group or review sessions. Their input was recorded, and the team wrote down what it changed because of it. Participants are described by role or group. |
| Why this is asked | Communities know what will work and what will harm them in ways a project team cannot, and their review is an outside check on the team's blind spots. Risk areas: Lack of Human Oversight and Feedback Loop Absence. |
| Reason prompt | Describe who took part, by group or role, how and when. Say what you changed because of their input. Do not upload lists of participants. |
| Evidence example 1 | notes from community review sessions |
| Evidence example 2 | the terms of reference of a community advisory group |
| Evidence example 3 | a note of the changes made after their input |
| Help text | Community involvement ensures the system addresses real needs and doesn't impose solutions that lack local relevance. |
| Example | Include representatives from the communities affected by the system in reviewing how its outputs are presented, interpreted, and acted on. |

## Q-PO-21

**Question:** Have you assessed the AI system's impact on existing workflows and professional practices?

| Text | Wording |
|---|---|
| Expected practice | The team looked at how the system changes the work of the people who use it, such as extra steps, time and responsibilities, and tried it in the real workflow. It wrote down the problems found and what it changed. |
| Why this is asked | A system that adds work or confusion gets used badly or not at all, and staff may start to rely on it in ways nobody planned. Risk areas: Lack of Human Oversight and User Literacy Deficit. |
| Reason prompt | Describe the changes to the workflow you found and how you found them, naming staff by role. Say what you changed. |
| Evidence example 1 | notes from a trial in the workflow |
| Evidence example 2 | feedback from users, by role |
| Evidence example 3 | the updated workflow description |
| Help text | AI systems that disrupt established workflows may face resistance, be misused, or create unintended safety concerns. |
| Example | Assess whether end-users can integrate AI recommendations into their existing workflow without adding unreasonable overhead. |

## Q-PO-22

**Question:** Have you ensured compliance with applicable data protection regulations and ethical guidelines?

| Text | Wording |
|---|---|
| Expected practice | The team identified which data-protection, research-ethics and sector rules apply where the system is built and where it is used. Examples are Uganda's Data Protection and Privacy Act 2019 and the national research guidelines. It obtained the approvals and registrations they require, and keeps a record of each with its reference and date. |
| Why this is asked | Approvals are easy to lose track of when research moves into use, and a missing one can stop a deployment and expose the people whose data is used. Risk area: Accountability Gap. |
| Reason prompt | List each rule you identified and the approval or registration you hold for it: body, reference and date. Say which you are still waiting for. The platform records your statement and makes no judgement of it. |
| Evidence example 1 | approval letters |
| Evidence example 2 | registration documents |
| Evidence example 3 | a data protection impact assessment |
| Evidence example 4 | a note from the institution's data protection officer |
| Help text | Data protection laws and ethics guidelines set a minimum. Meeting them does not answer every question about responsible use. |
| Example | List the national data protection law, the research ethics approvals and any sector rules that apply where the system is used, with the approval you hold for each. |

## Q-PO-23

**Question:** Have you established regular review cycles to reassess the AI system's appropriateness and performance?

| Text | Wording |
|---|---|
| Expected practice | The team holds reviews on a set schedule, in proportion to the risk, that look at performance, results by group, user feedback and whether the system is still needed. The decisions are recorded and acted on. |
| Why this is asked | Monitoring watches the numbers, but only a review on a set date asks whether the system should still be used as it is. Risk areas: Deployment Drift and Accountability Gap. |
| Reason prompt | Say how often reviews are held, who takes part, by role, and the date of the last one. Say what it decided. |
| Evidence example 1 | the review schedule |
| Evidence example 2 | minutes of the last review |
| Evidence example 3 | the decision record of a review |
| Help text | Regular reviews catch gradual degradation and ensure the system remains fit for its intended purpose. |
| Example | Schedule quarterly reviews of model performance, fairness metrics, and user feedback to decide on retraining, updates, or decommissioning. |

## Q-PO-24

**Question:** Have you considered the AI system's impact on equity of access to services?

| Text | Wording |
|---|---|
| Expected practice | The team checked whether people with less access can reach and use the system, such as those with older phones, poor connectivity, low literacy or another language. It wrote down any gap in access and what it did about it. |
| Why this is asked | A service delivered through an AI system can leave out the people who most need it, and checking access shows who is left behind. Risk area: User Literacy Deficit. |
| Reason prompt | Name the groups whose access you checked and what you found. Say what you changed. |
| Evidence example 1 | results of testing on basic phones or offline |
| Evidence example 2 | notes from users with limited access |
| Evidence example 3 | a note on the changes made |
| Help text | AI systems can inadvertently widen or narrow equity gaps in service delivery. |
| Example | Does the AI tool work equally well for users with limited internet connectivity, older devices, or lower digital literacy? |

Batch `post-processing` sha256: `29e615fa219116d888751b9679489a135a8cf6a44042c0a91257a65949e4bb86`
