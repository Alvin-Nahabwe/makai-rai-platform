# The pre-processing texts of content 5.0.0

22 questions, in the order S-12 shows them.

## Q-PP-01

**Question:** Have you evaluated whether AI/ML is the most appropriate approach, compared to simpler alternatives (e.g., statistical models, rule-based systems, manual processes)?

| Text | Wording |
|---|---|
| Expected practice | Before building, the team compared the AI approach with at least one simpler method and one non-computational option for the same problem. The comparison covers expected performance, cost, the skills and infrastructure each needs to keep running, and the risks to the people affected. The team wrote down its choice and why. |
| Why this is asked | An AI model that a rule or a manual process could match still costs money, power and upkeep, and its errors fall on the people it serves. Risk area: Techno-solutionist Bias. |
| Reason prompt | Name the alternatives you compared and what decided it. This text is not printed in any document; it is your record of the choice. Not applicable is unusual here; if you choose it, say why. |
| Evidence example 1 | a C-01 alternatives analysis, filled in |
| Evidence example 2 | the protocol section with the comparison |
| Evidence example 3 | minutes of the meeting where the choice was made |
| Help text | Consider whether simpler methods (e.g., logistic regression, decision trees, manual review) could achieve comparable results with less complexity and fewer concerns. |
| Example | Would a basic statistical dashboard or a rule-based alert system get the job done, or does the problem genuinely need a machine learning model? |

## Q-PP-02

**Question:** Have you clearly defined the problem your AI system aims to solve, including specific objectives and success criteria?

| Text | Wording |
|---|---|
| Expected practice | The team wrote a problem statement that names who has the problem, what decision or task the system will support, and what success looks like. Success is stated in terms the team can check later: the measure, the target the team set for itself, and what would count as not good enough. |
| Why this is asked | Without a written problem statement nobody can tell later whether the system helped, and the work drifts towards whatever the data happens to allow. Risk area: Techno-solutionist Bias. |
| Reason prompt | State the problem, who it affects and the success measures you set, facts first. This text is printed in the data card under "Intended uses" and in the model card under "Primary use case". Then say where the full statement is kept. |
| Evidence example 1 | the problem statement in the protocol or concept note |
| Evidence example 2 | a one-page project brief with objectives and success measures |
| Evidence example 3 | minutes of the meeting where the objectives were agreed |
| Help text | A well-defined problem statement helps ensure the AI solution addresses a real need. |
| Example | Instead of a vague goal like 'improve outcomes', write one you can check. For example: 'flag as many pregnancies needing referral as the paper checklist does, with fewer false alarms, at four health centres by June'. |

## Q-PP-03

**Question:** Have you identified all stakeholders who are directly or indirectly affected by the AI system?

| Text | Wording |
|---|---|
| Expected practice | The team listed the groups the system affects. These include the people who use its outputs, the people the outputs are about, the people whose data trains it, and others who carry its costs or benefits. For each group the list says how the system affects it. |
| Why this is asked | Groups left off the stakeholder list are the ones whose harms nobody plans for, and the later questions on groups, consent and consultation all build on it. Risk area: Population Bias. |
| Reason prompt | Name the groups you identified, by role or category and never as individuals, and how each is affected. This text is printed in the model card under "Primary intended users", so start with who will use the outputs. Say where the full list is kept. |
| Evidence example 1 | a stakeholder list or map in the protocol |
| Evidence example 2 | a C-07 stakeholder impact map, filled in |
| Evidence example 3 | notes from a meeting where the list was reviewed |
| Help text | Think broadly: end-users, people whose data you're using, administrators, regulators, and communities affected by the system's decisions. |
| Example | Take a model that flags children for nutrition follow-up. Those affected include caregivers, the village health teams who act on the flags, district health officers, the clinics whose records train it, and families the data misses. |

## Q-PP-04

**Question:** Have you assessed how the AI system might affect protected or vulnerable groups (e.g., by gender, age, ethnicity, disability, socioeconomic status)?

| Text | Wording |
|---|---|
| Expected practice | The team named the groups who could be harmed or left out where the system will be used, including groups marginalised locally. For each, it wrote down how the system could affect it and what the team will check or change because of it. |
| Why this is asked | Harms from AI systems fall most often on groups already disadvantaged and least present in the data, and which groups those are depends on the setting. Risk areas: Historical & Societal Bias and Population Bias. |
| Reason prompt | Name the groups you considered and the main effect you found for each. Describe groups, never individuals, and do not upload records about them. Say what you decided to do about the largest risk. |
| Evidence example 1 | the group effects section of the protocol or C-02 assessment |
| Evidence example 2 | notes from a consultation with group representatives |
| Evidence example 3 | a written analysis of effects by group |
| Help text | Protected groups may vary by context. Consider both legally protected categories and locally marginalized populations. |
| Example | A crop pest detection model trained mostly on images from large commercial farms might misclassify pests on smallholder plots where growing conditions differ. |

## Q-PP-05

**Question:** Have you conducted a human rights impact assessment for the AI system?

| Text | Wording |
|---|---|
| Expected practice | In proportion to the risk, the team assessed how the system could affect people's rights, such as privacy, fair treatment, access to services and the chance to challenge a decision. For a low-stakes tool this can be a short written note; for a system that decides about people it is a fuller assessment. |
| Why this is asked | Some harms fall on everyone the system touches, such as a lost chance to appeal or a withheld service; this question asks about those rights, Q-PP-04 about particular groups. Risk areas: Historical & Societal Bias and Population Bias. |
| Reason prompt | Say which rights you looked at, what you found and what you changed. If you judged a short note enough, say why the risk is low. Name any reviewer by role. |
| Evidence example 1 | the rights assessment, or its section of the C-02 assessment |
| Evidence example 2 | an ethics committee's comments on rights |
| Evidence example 3 | the decision note on changes made |
| Help text | Assess potential harms to life, security, privacy, freedom of expression, fair distribution of services, and other human rights. |
| Example | For a student performance prediction system, assess whether it could limit access to educational opportunities or reinforce existing inequalities in resource allocation. |

## Q-PP-24

**Question:** Have you checked which perspectives the problem needs (disciplines, lived experience, gender, language and culture of the people affected) and brought in the ones your team lacks?

| Text | Wording |
|---|---|
| Expected practice | The team listed the perspectives the problem needs and compared them with the people it has. It filled the gaps it found, for example with a domain adviser, a community representative or a reviewer from another discipline. The list says who fills each gap, by role, and how they take part. |
| Why this is asked | A team whose members share one background misses the same things, so it needs to know which perspectives are missing and bring them in, for example through C-20 Multi-stakeholder Consultation. Risk areas: Historical & Societal Bias and Population Bias. |
| Reason prompt | Name the perspectives you found missing and who now provides them, by role. Do not record anyone's gender, nationality or other personal details. |
| Evidence example 1 | the perspectives list |
| Evidence example 2 | terms of reference for an advisory group |
| Evidence example 3 | notes from a review by an outside adviser |
| Help text | A perspective is a kind of knowledge the problem needs: a discipline, the lived experience of the people affected, or their language and culture. List the ones the problem needs, compare them with your team, and bring in the ones missing. |
| Example | A team in Gulu building a maternal-health chatbot had engineers only. It added a midwife as adviser, and tested the questions in Acholi with a mothers' group at the health centre. |

## Q-PP-07

**Question:** Have you assessed the environmental sustainability impact (e.g., energy consumption, carbon footprint) of the proposed AI solution?

| Text | Wording |
|---|---|
| Expected practice | Before building, the team estimated the computing the work needs for training and for running the system, and the energy that uses, and weighed that cost against the expected benefit. An estimate can come from hardware hours times the device's power draw, or from a tool such as CodeCarbon. The team wrote down the estimate and its choice. |
| Why this is asked | Large models use energy and money that small projects and unreliable grids can ill afford, and an early estimate leaves time to choose a lighter method. Risk area: Environmental Impact. |
| Reason prompt | Give your estimate of computing hours and energy, and how you made it. This text is printed in the model card under "Environmental note: compute and energy". Say what you chose because of it. |
| Evidence example 1 | the estimate in the protocol or C-02 assessment |
| Evidence example 2 | a CodeCarbon summary file |
| Evidence example 3 | a note comparing the energy use of two candidate methods |
| Help text | Consider the computational resources required for training and inference, and whether the environmental cost is justified by the expected benefit. |
| Example | Training a large transformer model for a task that a logistic regression could handle wastes energy and computing resources. |

## Q-PP-08

**Question:** Have you documented the data sources, collection methods, and rationale for data selection?

| Text | Wording |
|---|---|
| Expected practice | The team wrote down, for each data source, where the data came from, who collected it, how and when, and why it was chosen for this problem. The record is kept with the data, for example as a datasheet, so that someone outside the team could judge whether the data fits the use. |
| Why this is asked | Without a record of how the data was gathered, nobody can judge whether it fits a use, repeat the work or see the limits of the data. Risk area: Documentation Deficit. |
| Reason prompt | Say why the data was gathered, then how: sources, methods, period and setting, facts first. This text is printed in the data card under "Purpose" and "How was the data collected". Attach or link the datasheet, which the model card reads for "Dataset name". Never upload the data itself. |
| Evidence example 1 | a datasheet for the dataset (C-19) |
| Evidence example 2 | an issued data card from this platform |
| Evidence example 3 | the data collection section of the protocol |
| Evidence example 4 | a link to the data-access agreement |
| Help text | Good documentation enables reproducibility and allows others to assess data quality and fitness for purpose. |
| Example | Record whether data was collected prospectively or retrospectively, from which sources, over what time period, and under what conditions. |

## Q-PP-09

**Question:** Have you assessed whether your training data is representative of the target population?

| Text | Wording |
|---|---|
| Expected practice | The team compared the make-up of its data with the population it will serve, group by group, for example by sex, age group, district, language, or rural and urban. It used a source such as census or clinic figures, and wrote down which groups are under-represented and what it did about them. |
| Why this is asked | A model learns the population in its data, not the one it will serve, so thin groups get worse results that nobody notices unless someone compares. Risk areas: Data Scarcity & Availability Bias, Population Bias and Sampling & Generalization Bias. |
| Reason prompt | First give the make-up of the data by group and place, then the groups it under-represents and what you did. The model card prints this under "Geographic scope and demographic composition" and "Known limitations and under-represented populations". The data card prints it in its field on composition and bias checks. Give counts, never records about people. |
| Evidence example 1 | the summary file from the C-05 notebook |
| Evidence example 2 | a table comparing the data and the population by group |
| Evidence example 3 | the representativeness section of the protocol |
| Help text | Representativeness means the training data reflects the diversity of the population the model will serve. |
| Example | Does your dataset cover the range of conditions the model will encounter? If you trained on urban data but deploy in rural areas, representation gaps will hurt performance. |

## Q-PP-11

**Question:** Have you identified and addressed potential proxy variables for protected attributes?

| Text | Wording |
|---|---|
| Expected practice | The team checked which input variables could stand in for a sensitive attribute in its setting, such as village for ethnicity or phone type for income. Where it had the data, it tested how strongly they are linked. It wrote down what it decided for each: keep, remove or monitor. |
| Why this is asked | Removing a sensitive attribute does not stop a model using it when another variable, such as place, language or name, carries the same information. Risk area: Historical & Societal Bias. |
| Reason prompt | Say first whether the model uses or predicts any sensitive attribute, then name the variables you checked, how you tested them and what you decided. This text is printed in the model card's field on sensitive attributes. Do not record anyone's attributes. |
| Evidence example 1 | the output of a check on links between variables |
| Evidence example 2 | a decision note listing possible stand-in variables and choices |
| Evidence example 3 | the feature list with notes |
| Help text | Proxy variables indirectly encode protected attributes. For example, postal code may proxy for ethnicity, or occupation may proxy for socioeconomic status. |
| Example | Postal code can proxy for ethnicity in segregated regions. School district can proxy for socioeconomic status. Identify these indirect encodings and decide how to handle them. |

## Q-PP-12

**Question:** Have you ensured the quality and consistency of data labels/annotations?

| Text | Wording |
|---|---|
| Expected practice | The team wrote labelling guidelines, had a share of items labelled twice, measured how often the labellers agreed, and resolved or recorded the disagreements. Where labels come from routine records, it checked a sample against the source. The team set and wrote down the share and the agreement it accepts. |
| Why this is asked | A model is no better than its labels, and when one site or language is labelled differently, the errors fall on the people from it. Risk area: Labeling Bias. |
| Reason prompt | Say how labels were assigned and by whom, by role, facts first. This text is printed in the data card's field on how labels were assigned. Attach the agreement results, which the data card prints in its field on label quality checks. |
| Evidence example 1 | the labelling guidelines |
| Evidence example 2 | the agreement summary from the C-04 notebook |
| Evidence example 3 | a note on how disagreements were resolved |
| Help text | Inconsistent labeling introduces noise and can systematically disadvantage certain groups. |
| Example | Annotation inconsistencies between labelers using different criteria, or labels that change meaning across languages, facilities, or time periods. |

## Q-PP-GATE-SENSITIVE

**Question:** Does your dataset contain sensitive or personally identifiable information (PII)?

| Text | Wording |
|---|---|
| Expected practice | The team checked every field and file it will hold, including free text, images and audio, for anything that could identify a person directly or in combination with other data, and recorded the answer. |
| Why this is asked | Personal data brings duties of consent and protection, and data can identify a person through a combination, such as a village, an age and a rare condition. Risk area: none of its own; the next two questions cover Privacy & Consent Violations. |
| Reason prompt | Say which data you checked, field by field or file by file, and what you found. Describe the kinds of data; never copy personal data here. Your answer is printed in the data card's fields on consent and on personal data, and in the model card's field on sensitive attributes. If you answer not sure, say what you still need to check. |
| Evidence example 1 | a data inventory saying for each field whether it can identify a person |
| Evidence example 2 | the data protection section of the protocol |
| Help text | Sensitive data includes names, addresses, financial records, identity documents, ethnicity, or any information that could identify an individual. |

## Q-PP-13

**Question:** Have you obtained proper informed consent for data collection and use?

| Text | Wording |
|---|---|
| Expected practice | People whose data the team uses were told, in a language and form they understand, what it is for and that it may be used to build an AI system. They were also told who will use it, how long it is kept and how to withdraw, and they agreed to the uses now planned. Where others collected the data, or an ethics committee waived consent, the team holds the record of that. |
| Why this is asked | Consent for one purpose does not automatically cover training a model, and uses beyond it can stop the work and lose the trust of those who shared the data. Risk area: Privacy & Consent Violations. |
| Reason prompt | Say how consent was obtained (written, oral with a witness, community and individual), in which languages, and whether it covers AI use and sharing. If a committee waived consent, name the committee and the reference. This text is printed in the data card under "Informed consent". Attach the blank form, never signed forms. |
| Evidence example 1 | blank consent form and information sheet |
| Evidence example 2 | the ethics approval letter, or the waiver, or its reference |
| Evidence example 3 | the consent clause of a data-access agreement |
| Help text | Informed consent means data subjects understand how their data will be used, by whom, and for what purpose. |
| Example | People whose data you use should understand what it will be used for and have the option to opt out. |

## Q-PP-14

**Question:** Have you applied appropriate anonymization or pseudonymization techniques to protect personal data?

| Text | Wording |
|---|---|
| Expected practice | Before analysis, the team removed or replaced direct identifiers and coarsened details that could identify a person in combination, such as exact dates, small villages or rare conditions. It checked the result for people who could still be singled out. Any key that links codes to people is kept apart from the data, open only to set roles. |
| Why this is asked | Removing names is not enough when a few details together point to one person, and if de-identified data leaks or is shared, the people in it should not be recognisable. Risk area: Privacy & Consent Violations. |
| Reason prompt | Say which identifiers you removed or replaced, what you coarsened and how you checked the result, facts first. This text is printed in the data card under "Personal or sensitive data, and de-identification" and in its field on preprocessing. Say where any linking key is kept, by role, never the key itself. |
| Evidence example 1 | the de-identification steps in the data management plan |
| Evidence example 2 | the summary file from the C-10 notebook |
| Evidence example 3 | a report of a check for people who could be singled out |
| Help text | Anonymization removes identifying information; pseudonymization replaces identifiers with artificial ones. |
| Example | Replace names with random IDs, generalize ages to ranges, and remove rare attributes that could identify individuals through combination. |

## Q-PP-16

**Question:** Which of the following data quality assessments have you performed?

| Text | Wording |
|---|---|
| Expected practice | Before training a model, the team ran the quality checks its data needs and wrote down what each found. For most tabular data that means all eight checks listed. For images, text or audio, the reason says which checks do not fit and what was done instead. |
| Why this is asked | Quality problems found after training are far harder to trace; most common are records missing for some places or periods. Risk areas: Data Scarcity & Availability Bias, Historical & Societal Bias, Population Bias, Sampling & Generalization Bias, Data Integrity Compromise and Documentation Deficit. |
| Reason prompt | Tick the checks you ran. For each check you did not run, say whether it is not relevant to your data or still to do. Your ticks and reason are printed in the data card under "Missing data: extent and patterns", "What preprocessing or cleaning was applied" and "Retention policy and versioning". |
| Evidence example 1 | the summary file from the C-03 notebook |
| Evidence example 2 | a data-quality report |
| Help text | Data quality assessments catch issues early that could propagate into biased or unreliable models. |
| Example | Look for systematic gaps: are records from certain regions, time periods, or demographic groups consistently incomplete? |

## Q-PP-17

**Question:** Which of the following bias types have you assessed for in your data?

| Text | Wording |
|---|---|
| Expected practice | The team assessed its data for each bias type that fits how the data was made, and wrote down what it found. Most projects need checks for historical, population, sampling, measurement and exclusion bias, for labelling bias where people assigned labels, and for survey and survivorship bias where those apply. Unticked types are explained as not relevant. |
| Why this is asked | Each bias type enters data in its own way, so each needs its own check. Risk areas: Data Scarcity & Availability Bias, Historical & Societal Bias, Population Bias, Sampling & Generalization Bias and Labeling Bias. |
| Reason prompt | Tick the types you assessed. For each type you did not, say whether it does not fit your data or is still to do. Your ticks are printed in the data card's field on bias checks, and labelling bias in its field on label quality checks. |
| Evidence example 1 | the bias assessment notes |
| Evidence example 2 | the summary file from the C-04 notebook |
| Evidence example 3 | a data-quality report with a section on bias |
| Help text | Different bias types require different detection and mitigation strategies. Assessing for multiple types gives broader coverage. |
| Example | Historical bias in legacy records; population bias from convenience sampling; labeling bias from inconsistent annotation guidelines across sites. |

## Q-PP-18

**Question:** Have you assessed whether your data collection methods could introduce selection bias?

| Text | Wording |
|---|---|
| Expected practice | The team described how people or records came into the data. It noted who could be missing, such as people without phones, those who do not attend clinics, or areas without coverage. It wrote down how it measured or corrected for that. |
| Why this is asked | Data gathered only from people who are easy to reach leaves out the rest, so the model works least well for those already hardest to serve. Risk areas: Data Scarcity & Availability Bias and Sampling & Generalization Bias. |
| Reason prompt | Say whether the data is a sample or a full collection, how it was gathered and who could be missed, facts first. This text is printed in the data card's field on sampling. Then say what you did about the gap. |
| Evidence example 1 | the sampling section of the protocol |
| Evidence example 2 | a comparison of who is in the data with who was eligible |
| Evidence example 3 | a note on corrections made |
| Help text | Selection bias occurs when the data collection process systematically excludes certain populations. |
| Example | Collecting data only from users who actively engage with a platform excludes those who lack access, creating a skewed picture of the population. |

## Q-PP-19

**Question:** Have you evaluated whether historical patterns in the data reflect past discrimination or systemic inequities?

| Text | Wording |
|---|---|
| Expected practice | The team looked at whether past decisions recorded in the data, such as who was referred, treated or given credit, reflect unfair treatment of some groups. It wrote down what it found and whether it changed the labels, the features or the use of the model because of it. |
| Why this is asked | A model trained on past decisions learns to repeat them, including unfair ones, and records of who received a service often show access, not need. Risk area: Historical & Societal Bias. |
| Reason prompt | Say which past patterns you examined and what you found, facts first. This text is printed in the data card's field on dataset composition and bias checks. Then say what you changed. |
| Evidence example 1 | a written analysis of past patterns by group |
| Evidence example 2 | notes from a review with domain experts |
| Evidence example 3 | the decision note on changes made |
| Help text | Historical data may encode past injustices that, if learned by a model, perpetuate discrimination. |
| Example | Lending data may encode decades of redlining. Hiring data may reflect historical gender imbalances. Enrollment data may underrepresent marginalized communities. |

## Q-PP-20

**Question:** Have you assessed the temporal relevance of your training data?

| Text | Wording |
|---|---|
| Expected practice | The team recorded the period the data covers and checked whether conditions have changed since, for example new policies, seasons, outbreaks, prices or devices. It wrote down whether the data still fits the period the system will be used in. |
| Why this is asked | Data describes the time it was collected, so a model built on old data may serve a situation that no longer exists. Risk areas: Data Scarcity & Availability Bias and Deployment Drift. |
| Reason prompt | Give the period the data covers, then the changes since that matter. This text is printed in the data card under "Time period". Say what you did about any change. |
| Evidence example 1 | the data description with dates |
| Evidence example 2 | a note on changes since collection |
| Evidence example 3 | a comparison of older and recent data |
| Help text | Data collected years ago may not reflect current conditions, behaviors, or demographics. |
| Example | Training on pre-2020 economic data to predict current consumer behavior misses major behavioral shifts from recent global events. |

## Q-PP-21

**Question:** Have you established data governance policies covering access, sharing, and retention?

| Text | Wording |
|---|---|
| Expected practice | The team wrote down who may use the data and how, the conditions for sharing it with partners, and where it is stored. It also set how long the data is kept, how it is deleted and who decides, by role. In proportion to the risk, this can be a section of the data management plan. |
| Why this is asked | Data that nobody governs drifts into copies on laptops and shared drives, outside the protections the people in it were promised and the project's agreements. Risk areas: Privacy & Consent Violations and Accountability Gap. |
| Reason prompt | Say who can use the data, where it is stored and the sharing conditions, facts first. This text is printed in the data card under "Access controls and geographic restrictions" and "Retention policy and versioning". Name people by role, never by name. |
| Evidence example 1 | the data management plan |
| Evidence example 2 | a data-sharing or data-access agreement |
| Evidence example 3 | the storage and access settings, described or linked |
| Help text | Data governance ensures data is managed responsibly throughout its lifecycle. |
| Example | Define who can access the data, under what conditions it can be shared with partners, and how long it should be retained before deletion. |

## Q-PP-22

**Question:** Have you evaluated whether your data adequately represents edge cases and rare conditions?

| Text | Wording |
|---|---|
| Expected practice | The team listed the rare cases and conditions the system will meet in use and checked how many of each are in the data. It wrote down which are too few to learn from and how it handled them, for example by collecting more, grouping them or stating them as a limit. |
| Why this is asked | Rare cases, such as a severe illness or an unusual pest, often have the most at stake, and a model that has seen too few of them handles them badly. Risk areas: Data Scarcity & Availability Bias and Population Bias. |
| Reason prompt | Name the rare cases you checked and how many of each the data holds. This text is printed in the data card's field on dataset composition and in the model card under "Known limitations and under-represented populations". Say what you did about those too few to learn from. |
| Evidence example 1 | a count of rare cases in the data |
| Evidence example 2 | the summary file from a data profiling notebook |
| Evidence example 3 | a note on the cases stated as limits |
| Help text | Rare events and edge cases are often underrepresented, leading to poor model performance for affected individuals. |
| Example | A fraud detection model needs enough examples of novel fraud patterns, not just common ones. A crop classifier needs rare pest variants, not just the top five. |

## Q-PP-23

**Question:** Have you engaged domain experts in reviewing data quality and relevance?

| Text | Wording |
|---|---|
| Expected practice | People who know the field the data comes from, such as clinicians, agronomists or teachers, reviewed a sample of the data and its labels. They looked for errors and for meaning lost in recording, and the team wrote down what they found and what it changed. |
| Why this is asked | Domain experts notice errors that checks by code miss, such as a diagnosis code used differently at one clinic, and their review is often the cheapest way to find them. Risk areas: Labeling Bias and Aggregation Bias. |
| Reason prompt | Say who reviewed the data, by role, what they looked at and what they found. This text is printed in the data card's field on how labels were assigned and by whom. Then say what you changed. |
| Evidence example 1 | notes from the expert review |
| Evidence example 2 | a list of corrections made after the review |
| Evidence example 3 | terms of reference for the reviewers |
| Help text | Domain experts catch quality issues that automated checks miss, especially around labeling accuracy and contextual meaning. |
| Example | An agronomist reviewing crop labels, a teacher checking student performance categories, or a financial analyst verifying transaction codes can each spot errors a data scientist would not. |

Batch `pre-processing` sha256: `fbd3d6f2bde96d992dbd4ccf38ea8c4c42731a468fb9d73fb52c8b395ee84f85`
