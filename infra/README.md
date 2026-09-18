# infra

AWS CDK app (TypeScript) for POP HQ.

| File | Contents |
| --- | --- |
| `bin/pophq.ts` | App entry: the `PopHqPipeline` stack in account 529088263366, eu-central-1 |
| `lib/pipeline-stack.ts` | CodePipeline: GitHub connection, checks + synth, self-update, `Prod` stage, smoke test |
| `lib/app-stage.ts` | `Prod` stage; runs cdk-nag itself because aspects don't cross stage boundaries |
| `lib/app-stack.ts` | DynamoDB table, API Lambda + API Gateway REST, Cognito user pool, S3 + CloudFront web hosting |

`npm run synth -w infra` needs `web/dist` (run `npm run build` first) and no AWS credentials. cdk-nag errors fail the synth; every acknowledged rule has a written reason in the stack.

`exactOptionalPropertyTypes` is off in this package only: CDK's jsii-generated types are not compatible with it.
