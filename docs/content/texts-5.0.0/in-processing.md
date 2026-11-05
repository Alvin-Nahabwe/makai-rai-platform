# The in-processing texts of content 5.0.0

22 questions, in the order S-12 shows them.

## Q-IP-01

**Question:** Have you justified the choice of model architecture relative to the problem complexity and data availability?

| Text | Wording |
|---|---|
| Expected practice | The team wrote down the model types it considered and why the chosen one fits the problem, the data, and the people who must understand or maintain it. It also noted what it gave up by choosing it. |
| Why this is asked | A model chosen by habit may be harder to explain and keep running than the problem needs, and a written choice shows later users what it was built to do. Risk areas: Opacity & Unexplainability and Metric Selection Bias. |
| Reason prompt | Name the model type and the alternatives you considered, then why you chose it. This text is printed in the model card under "Architecture". Keep it short and factual. |
| Evidence example 1 | the model choice note |
| Evidence example 2 | the methods section of the protocol |
| Evidence example 3 | a comparison table of candidate models |
| Help text | Model selection should be a deliberate choice, not a default. Document why the chosen architecture fits the problem. |
| Example | For a classification task with limited data, a gradient boosted tree may outperform a neural network while being far easier to explain to stakeholders. |

## Q-IP-02

**Question:** Have you ensured that training, validation, and test datasets are representative of the same underlying population?

| Text | Wording |
|---|---|
| Expected practice | The team split its data into training, validation and test sets so that no person, household or site appears in more than one where that would leak information. It checked that the sets come from the same population, and wrote down how the test set differs from the setting of use. |
| Why this is asked | When test data overlaps with training data, or comes from a different population, the reported performance is wrong in ways nobody sees until the system is used. Risk areas: Algorithmic Discrimination and Aggregation Bias. |
| Reason prompt | Say how you split the data and how you checked the splits, facts first. This text is printed in the model card under "Evaluation data and how it differs from training data". Say how the test data differs from where the model will be used. |
| Evidence example 1 | the data split code or its description |
| Evidence example 2 | a table comparing the sets by group and source |
| Evidence example 3 | the evaluation section of the protocol |
| Help text | Data leakage or distributional mismatch between splits can produce misleadingly optimistic performance estimates. |
| Example | If your training data comes entirely from one region but your test set includes another, your performance estimates will be unreliable. |

## Q-IP-03

**Question:** Have you evaluated model performance using a confusion matrix and derived metrics (precision, recall, F1, specificity)?

| Text | Wording |
|---|---|
| Expected practice | On held-out test data, the team reported the confusion matrix and the measures that matter for its use, such as precision, recall, specificity and F1. It wrote down which kind of error costs the people affected more, and so which measure it watches most. |
| Why this is asked | Accuracy alone can hide a model that misses most of the cases that matter, and which error is worse, a missed case or a false alarm, depends on the use. Risk area: Metric Selection Bias. |
| Reason prompt | Name the measures you report and why those, then the error that costs most. Attach the results file: the model card lists it under "Overall metrics", and you type the numbers there when you generate the card. Report the numbers, not judgements of them. |
| Evidence example 1 | the evaluation report with the confusion matrix |
| Evidence example 2 | the summary file from the evaluation notebook |
| Evidence example 3 | a link to the metrics in the repository |
| Help text | Overall accuracy can be misleading, especially with imbalanced classes. Derived metrics reveal performance nuances. |
| Example | On a dataset where nine in ten records are negative, a model that always says negative looks accurate. Its recall shows that it finds none of the cases that matter. |

## Q-IP-04

**Question:** Have you calculated performance metrics separately for each relevant subgroup (e.g., by age, gender, ethnicity)?

| Text | Wording |
|---|---|
| Expected practice | The team reported the model's main performance measures separately for each group that matters where it will be used, such as sex, age group, district, language, or rural and urban. The groups include any the data shows to be under-represented, and each result gives the number of cases. Groups too small for a reliable estimate are named as such, not left out. |
| Why this is asked | A model can look good on average and still work badly for one group, and the people in that group carry the cost of its errors. Risk areas: Algorithmic Discrimination, Aggregation Bias and Metric Selection Bias. |
| Reason prompt | Name the groups you used, why those groups, and the size of the smallest. When you generate the model card, type the numbers into "Disaggregated performance"; the platform does not compute them. Do not collect a new sensitive attribute, such as ethnicity, just for this check without consent (see Q-PP-13). |
| Evidence example 1 | the summary file from the C-14 notebook |
| Evidence example 2 | a per-group metrics table with group sizes |
| Help text | Disaggregated evaluation reveals whether the model performs equitably across different demographic groups. |
| Example | Compare accuracy, recall, and false negative rates across age groups, income brackets, geographic regions, or whatever subgroups matter for your deployment. |

## Q-IP-06

**Question:** Which fairness metrics have you computed?

| Text | Wording |
|---|---|
| Expected practice | The team chose the fairness measures that fit how the system's errors affect people, computed them for the groups it compares, and wrote down why those measures. Most systems that predict something about people need an error-rate measure and a calibration or precision measure. Unticked measures are explained as not fitting; a fitting measure not listed is named in the reason. |
| Why this is asked | Fairness measures answer different questions and cannot all be met at once, so a result means something only if the measures fit the use and the team says why. Risk areas: Algorithmic Discrimination and Aggregation Bias. |
| Reason prompt | Tick the measures you computed and say why they fit your use. Give the threshold you set for each and the groups compared. This text and your ticks are printed in the model card under "Fairness metrics with the team's own threshold". Explain each unticked measure. |
| Evidence example 1 | the summary file from the C-13 notebook |
| Evidence example 2 | a fairness report with the measures by group |
| Evidence example 3 | the decision note on which measures fit |
| Help text | Different fairness metrics capture different aspects of equitable treatment. No single metric is sufficient. |
| Example | Statistical Parity checks equal selection rates; Predictive Parity checks equal precision; Treatment Equality checks equal error rate ratios. |

## Q-IP-07

**Question:** Have you applied explainability methods (e.g., SHAP, LIME, feature importance) to understand model decisions?

| Text | Wording |
|---|---|
| Expected practice | The team used at least one explanation method that fits its model, such as feature importance, SHAP or LIME. It checked with people who know the field whether the main drivers of predictions make sense, and wrote down what it found, including any driver that should not matter. |
| Why this is asked | Explanations show whether a model relies on what it should, and a driver that makes no sense to a domain expert is often the first sign of a data problem. Risk area: Opacity & Unexplainability. |
| Reason prompt | Name the method you used and the main drivers it showed. Say whether a domain expert, by role, looked at them and what they concluded. |
| Evidence example 1 | the summary file from the C-18 notebook |
| Evidence example 2 | an explanation report with its plots |
| Evidence example 3 | notes from the expert review of the drivers |
| Help text | Explainability methods help stakeholders and decision-makers understand why the model made a particular prediction. |
| Example | SHAP values showed that distance to the clinic and the month of the visit drove most predictions. That led the team to check whether the model had learned the rainy season rather than the illness. |

## Q-IP-08

**Question:** Have you tested the model's robustness to distribution shifts, noise, and edge cases?

| Text | Wording |
|---|---|
| Expected practice | The team tested the model on inputs that differ from its training data in the ways expected in use. Examples are added noise, missing or wrong values, rare cases, lower image or sound quality, and other dialects, devices or sites. It used methods such as perturbation tests, held-out sites or the Adversarial Robustness Toolbox, and wrote down how much performance changed and what it did. |
| Why this is asked | Field data is noisier than the data a model is built on, so a model never tested on worse inputs can lose much of its accuracy in use without warning. Risk areas: Opacity & Unexplainability, Model Robustness Failure and Reproducibility Failure. |
| Reason prompt | Say what changes to the inputs you tested and how much performance moved, facts first. This text is printed in the model card's field on known limitations. Then say what you changed, or stated as a limit. |
| Evidence example 1 | the summary file from the perturbation part of the C-18 notebook |
| Evidence example 2 | a robustness test report |
| Evidence example 3 | results on a held-out site or device |
| Help text | Models that work well on clean data can lose accuracy in use, where the data shifts, carries noise or holds unusual inputs. |
| Example | Test how the model handles inputs from environments it wasn't trained on: different image quality, different dialects in text, different sensor calibrations. |

## Q-IP-16

**Question:** Have you compared your model's performance against a simple baseline (e.g., majority class, logistic regression)?

| Text | Wording |
|---|---|
| Expected practice | The team compared its model with at least one simple baseline, such as always predicting the most common class, the current rule or a logistic regression. It used the same test data, and wrote down whether the gain justifies the extra complexity. |
| Why this is asked | A complex model that barely beats a simple rule costs more to run and explain for little benefit, and the baseline shows whether the reported numbers mean anything. Risk area: Metric Selection Bias. |
| Reason prompt | Name the baseline and give both results. Say what you decided because of the comparison. |
| Evidence example 1 | the evaluation report with the baseline results |
| Evidence example 2 | the summary file from the evaluation notebook |
| Help text | Baseline comparison demonstrates whether model complexity is justified by meaningful performance improvement. |
| Example | If a random forest beats a simple decision tree by one or two points of accuracy, the extra complexity may not be worth what it costs in explanation and upkeep. |

## Q-IP-17

**Question:** Have you assessed whether the model relies on spurious correlations rather than meaningful features?

| Text | Wording |
|---|---|
| Expected practice | The team looked for features that only happen to go with the outcome in its data, such as the source site, a watermark or the time of recording. It checked whether the model relies on them, using explanations, tests on data from other sources or removing the suspect feature, and wrote down what it found. |
| Why this is asked | A model can do well in testing because of a shortcut in the data that will not hold in use, and the shortcut stays invisible until someone looks for it. Risk areas: Opacity & Unexplainability and Model Robustness Failure. |
| Reason prompt | Name the suspect features you checked, how, and what you found. Say what you changed. |
| Evidence example 1 | an explanation report showing the main drivers |
| Evidence example 2 | results on data from another site |
| Evidence example 3 | a note on the features removed and why |
| Help text | A spurious correlation is a link that holds in the training data but not where the system is used, often because of how the data was collected. It can give good test results and then stop working in use. |
| Example | An image classifier might learn to associate a particular watermark with a label because all images from one source carry that watermark, not because of actual content. |

## Q-IP-18

**Question:** Have you evaluated model uncertainty and calibration quality?

| Text | Wording |
|---|---|
| Expected practice | The team checked whether the model's stated confidence matches how often it is right, for example with a calibration plot on test data, and corrected it if needed. It wrote down how users should treat outputs with low confidence. |
| Why this is asked | Users act on a model's stated confidence, so a model that is confident and wrong is more dangerous than one that says it is unsure. Risk area: Model Robustness Failure. |
| Reason prompt | Say how you checked calibration and what you found. Say how outputs with low confidence are handled. |
| Evidence example 1 | a calibration plot or table |
| Evidence example 2 | the summary file from the evaluation notebook |
| Evidence example 3 | the rule for handling outputs with low confidence |
| Help text | A model is well calibrated when its stated confidence matches how often it is right. Of the cases it gives a 7 in 10 chance, about 7 in 10 turn out true. |
| Example | If a model says it is very confident on a set of cases, nearly all of them should turn out right. If only half do, users will trust it more than they should. |

## Q-IP-09

**Question:** Have you applied the parsimony principle, seeking the simplest model that achieves acceptable performance?

| Text | Wording |
|---|---|
| Expected practice | The team set what acceptable performance means for this use, then chose the simplest model that reaches it. It weighed how far the people affected, and those who act on the outputs, need to follow each decision, and wrote down the choice and what was traded. |
| Why this is asked | Simpler models are easier to explain, check and keep running, which matters most where people must understand decisions about them, so a small accuracy gain may not be worth it. Risk area: Opacity & Unexplainability. |
| Reason prompt | Say what performance you set as acceptable and which simpler models you tried. Say why you chose the one you did. |
| Evidence example 1 | the model choice note, stating the acceptable performance |
| Evidence example 2 | a comparison table of simpler and more complex models |
| Help text | The parsimony principle favors simpler models that are easier to interpret, maintain, and explain to stakeholders. |
| Example | If a logistic regression is nearly as good as a deep network on your test data, the simpler model may be the better choice. Health workers can follow how it reaches a result. |

## Q-IP-10

**Question:** Have you documented all hyperparameters, random seeds, and training configurations for reproducibility?

| Text | Wording |
|---|---|
| Expected practice | The team recorded what is needed to re-run training and get the same model, and keeps it with the model. That means the code and data versions, the preprocessing steps, the settings including hyperparameters and random seeds, and the software versions. |
| Why this is asked | Small changes in settings or software can change how a model behaves, so without these records nobody, including the team a year later, can repeat or check a result. Risk area: Reproducibility Failure. |
| Reason prompt | Say where the training records are kept and what they include. Say whether someone has re-run training from them. |
| Evidence example 1 | a link to the configuration files in the repository |
| Evidence example 2 | an experiment-tracking record, for example from MLflow |
| Evidence example 3 | the environment file listing package versions |
| Help text | Reproducibility requires that anyone can re-run your experiment and obtain the same results. |
| Example | Record the exact Python package versions, random seeds, data preprocessing steps, and hardware specifications used during training. |

## Q-IP-11

**Question:** Have you validated data integrity through your processing pipeline (ETL checks, validation rules)?

| Text | Wording |
|---|---|
| Expected practice | The team added checks at each step of its data pipeline that catch lost, duplicated or changed records. Examples are row counts, value ranges, units, date formats and the character encoding of local languages. It wrote down what the checks found. |
| Why this is asked | Errors made while data is moved and transformed are silent and can bias a model, and checks at each step catch them where they are cheap to fix. Risk area: Data Integrity Compromise. |
| Reason prompt | Name the checks you run and at which steps. Say what they found and how you fixed it. |
| Evidence example 1 | the validation rules or test code |
| Evidence example 2 | a pipeline log showing the checks |
| Evidence example 3 | a note on the errors found and fixed |
| Help text | Data corruption during transformation can silently degrade model quality without obvious errors. |
| Example | Validate that date format conversions, unit transformations, and encoding mappings preserve data accuracy through each pipeline stage. |

## Q-IP-12

**Question:** Have you created or updated a model card for this model?

| Text | Wording |
|---|---|
| Expected practice | The team wrote a model card for the current version of the model and updates it when the model changes. It covers the intended use, the data, performance overall and by group, the limits and the conditions for use. A model card issued by this platform counts. |
| Why this is asked | A model card tells those who deploy or rely on a model what it can and cannot do, and without one its limits are lost when the team moves on. Risk areas: Reproducibility Failure and Documentation Deficit. |
| Reason prompt | Say which version of the model the card describes and where it is kept. Attach or link it: the model card prints it under "Model card held by the team". |
| Evidence example 1 | the model card (C-17) |
| Evidence example 2 | an issued model card from this platform |
| Evidence example 3 | a link to the model card in the repository |
| Help text | Model cards document intended use, performance metrics, ethical considerations, limitations, and training details (Mitchell et al., 2019). |
| Example | A model card should state which populations the model was validated on, where performance degrades, and what it should not be used for. |

## Q-IP-13

**Question:** Which additional evaluation methods have you applied?

| Text | Wording |
|---|---|
| Expected practice | The team used the evaluation methods its model and data need to give stable and honest estimates, and wrote down what each showed. Most projects need cross-validation or bootstrapping, error analysis by subgroup and a sensitivity analysis; calibration and AUC-ROC where the model gives probabilities. Unticked methods are explained as not relevant. |
| Why this is asked | One test split gives one estimate, which may be lucky, while several methods together show how stable the results are and where the model is weak. Risk areas: Algorithmic Discrimination, Aggregation Bias, Metric Selection Bias and Model Robustness Failure. |
| Reason prompt | Tick the methods you used and give the main result of each. For each unticked method, say whether it does not fit or is still to do. A tick on AUC-ROC is printed in the model card under "Overall metrics". |
| Evidence example 1 | the evaluation report |
| Evidence example 2 | the summary file from the evaluation notebook |
| Help text | Multiple evaluation methods provide more robust evidence of model performance and help detect overfitting. |
| Example | Use k-fold cross-validation to get stable estimates, then calibration analysis to verify predicted probabilities match observed frequencies. |

## Q-IP-14

**Question:** Have you considered whether aggregating data across populations masks important subgroup differences?

| Text | Wording |
|---|---|
| Expected practice | The team compared results for the main subpopulations it pooled, such as regions, languages or types of facility, and checked whether pooled results hide opposite trends within them. It wrote down whether one model serves all or separate handling is needed. |
| Why this is asked | Pooling data can hide a group for which the model works badly, or even reverse a trend, and knowing this decides whether one model can serve everyone. Risk area: Aggregation Bias. |
| Reason prompt | Name the subpopulations you compared and what you found. Say what you decided. |
| Evidence example 1 | a table of results by subpopulation |
| Evidence example 2 | a note on the decision to pool or to separate |
| Help text | Simpson's paradox can occur when aggregate results hide opposing trends within subgroups. |
| Example | Pooling data from hospitals and village clinics may hide that a model works well in hospitals and poorly in clinics, where most people are seen. |

## Q-IP-15

**Question:** Have you identified and mitigated any bias introduced during hyperparameter tuning?

| Text | Wording |
|---|---|
| Expected practice | The team checked whether its tuning choices, such as the decision threshold, class weights and the measure it optimised, made results worse for some groups. It compared results by group before and after tuning, and wrote down the changes it made. |
| Why this is asked | Tuning for the best overall result often favours the largest group, and a threshold chosen on the whole population can leave a smaller group with far more missed cases. Risk areas: Algorithmic Discrimination and Metric Selection Bias. |
| Reason prompt | Say which tuning choices you checked and what changed by group, facts first. This text is printed in the model card under "Bias mitigations applied". Say what you changed. |
| Evidence example 1 | results by group before and after tuning |
| Evidence example 2 | the summary file from the C-15 notebook |
| Evidence example 3 | the tuning configuration with notes |
| Help text | Hyperparameter choices can inadvertently optimize for the majority group at the expense of minority groups. |
| Example | A decision threshold tuned on overall F1 may produce unacceptable false negative rates for underrepresented subgroups. |

## Q-IP-19

**Question:** Have you assessed whether the model's errors have differential impact across demographic groups?

| Text | Wording |
|---|---|
| Expected practice | The team described what each kind of error means for the people affected, such as a missed diagnosis or a service wrongly refused. It compared error rates across groups, and wrote down which groups bear more of the harm and what it will do about it. |
| Why this is asked | The same error rate can mean very different harm for different groups, and knowing who bears the errors shows where safeguards are needed. Risk areas: Algorithmic Discrimination and Aggregation Bias. |
| Reason prompt | Describe the consequences of each kind of error, then the groups that bear more of them. This text is printed in the model card under "Potential consequences of model errors". Give rates, never records about people. |
| Evidence example 1 | a table of error rates by group |
| Evidence example 2 | a written note on the consequences of each kind of error |
| Evidence example 3 | the summary file from the C-14 notebook |
| Help text | Equal overall error rates can mask disproportionate harm to specific groups if errors are distributed unequally. |
| Example | A screening model may miss few cases overall but many more among older women, if they are few in the data. The overall figure hides who carries the missed cases. |

## Q-IP-20

**Question:** Have you documented the model's known limitations, failure modes, and conditions under which it should not be used?

| Text | Wording |
|---|---|
| Expected practice | The team wrote down where the model is known to perform poorly or was not tested: populations, places, devices, languages and time periods. It also wrote down the kinds of errors it makes and the situations where it must not be used. The text is written for the people who will deploy or rely on the model and is kept with the model. |
| Why this is asked | People who deploy a model later often use it outside its setting, and written limits stop a model built in one district or language being used untested in another. Risk areas: Opacity & Unexplainability and Documentation Deficit. |
| Reason prompt | Write the limits here in two or three sentences, facts first. They are printed in the model card under "Out-of-scope uses" and in its field on known limitations. Then say where the full text is kept. |
| Evidence example 1 | the model card or its limitations section |
| Evidence example 2 | a test report showing the cases where the model goes wrong |
| Help text | Documenting limitations prevents misuse and sets appropriate expectations for deployment. |
| Example | State clearly that a model trained on data from one context has not been validated for use in a different context, and should not be applied there without further testing. |

## Q-IP-21

**Question:** Have you used version control for your model code, data processing pipelines, and trained model artifacts?

| Text | Wording |
|---|---|
| Expected practice | The team keeps its code, data processing and trained models under version control, for example Git for code and DVC or MLflow for data and models. Each model in use can then be traced to the code and data that made it. |
| Why this is asked | Without versions nobody can tell which code and data produced the model in use, and when something goes wrong that link is what lets the team find the cause. Risk area: Reproducibility Failure. |
| Reason prompt | Say what is under version control and with which tools. Give the version of the current model. |
| Evidence example 1 | a link to the repository |
| Evidence example 2 | the model registry entry |
| Evidence example 3 | the data version record |
| Help text | Version control enables tracking changes, reverting to known-good states, and collaborating effectively. |
| Example | Use git for code, DVC or similar for data versioning, and model registries (e.g., MLflow) for trained model artifacts. |

## Q-IP-22

**Question:** Have you assessed the model for potential adversarial vulnerabilities or manipulation?

| Text | Wording |
|---|---|
| Expected practice | In proportion to the risk of misuse, the team considered how someone could trick or manipulate the model, such as with altered images, reworded text or fake inputs. It tested the most likely ways, for example with the Adversarial Robustness Toolbox or by hand, and wrote down the results and the safeguards it chose. |
| Why this is asked | A model whose outputs bring a benefit or a penalty invites people to game it, and small changes to an input can flip a prediction. Risk areas: Model Robustness Failure and Data Integrity Compromise. |
| Reason prompt | Name the kinds of manipulation you considered and how you tested them. Say what you found and which safeguards you chose. |
| Evidence example 1 | an adversarial test report |
| Evidence example 2 | the summary file from the C-18 notebook |
| Evidence example 3 | a note on the safeguards chosen |
| Help text | Adversarial attacks can cause models to produce incorrect outputs with imperceptible input modifications. |
| Example | Test whether small perturbations to input data (slightly altered images, reworded text, modified sensor readings) cause the model to flip its prediction. |

## Q-IP-24

**Question:** Have you tested the model's performance on data from different time periods to assess temporal stability?

| Text | Wording |
|---|---|
| Expected practice | The team tested the model on data from a later period than its training data, or kept the most recent data aside for testing. It wrote down how performance changed over time and what that means for how long the model can be used. |
| Why this is asked | Seasons, policies and behaviour change, and a model's results can slip as they do; a test on later data shows how fast. Risk areas: Model Robustness Failure and Deployment Drift. |
| Reason prompt | Give the periods you trained and tested on and how the results changed. Say what you concluded about retraining. |
| Evidence example 1 | results by time period |
| Evidence example 2 | the evaluation report with a split by time |
| Help text | Models trained on historical data may not perform well on recent data due to temporal distribution shifts. |
| Example | A model trained on 2018-2020 data should be evaluated on 2021-2023 data to check whether it still holds up as conditions change. |

Batch `in-processing` sha256: `4ad742f5d57549739a03a8bc0bf1c3200a759df67dca5f2607bceeb78eb52394`
