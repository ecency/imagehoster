
SHELL := /bin/bash
PATH  := ./node_modules/.bin:$(PATH)

SRC_FILES := $(shell find src -name '*.ts')

all: lib

lib: $(SRC_FILES) node_modules tsconfig.json
	tsc -p tsconfig.json --outDir lib
	VERSION="$$(node -p 'require("./package.json").version')"; \
	BUILD="$$(git rev-parse --short HEAD)-$$(date +%s)"; \
	echo "module.exports = '$${VERSION}-$${BUILD}';" > lib/version.js
	touch lib

reports:
	mkdir reports

.PHONY: coverage
coverage: node_modules reports
	NODE_ENV=test nyc -r html -r text -e .ts -i ts-node/register \
		--report-dir reports/coverage \
		mocha --reporter nyan --require ts-node/register --exit test/*.ts

.PHONY: devserver
devserver: node_modules
	@onchange -i 'src/**/*.ts' 'config/*' -- ts-node src/app.ts | bunyan -o short

.PHONY: test
# --exit required: @hiveio/dhive Client keeps HTTP sockets alive with no close() API
test: node_modules
	@NODE_ENV=test mocha --require ts-node/register test/*.ts --exit --grep '$(grep)'

.PHONY: ci-test
ci-test: node_modules reports
	yarn audit
	eslint 'src/**/*.ts'
	NODE_ENV=test nyc -r lcov -e .ts -i ts-node/register \
		--report-dir reports/coverage \
		mocha --require ts-node/register \
		--timeout 30000 \
		--reporter $$([ -n "$$CI" ] && echo "mocha-junit-reporter" || echo "tap") \
		--reporter-options mochaFile=./reports/unit-tests/junit.xml \
		--exit test/*.ts

.PHONY: lint
lint: node_modules
	eslint 'src/**/*.ts' --fix

node_modules: package.json
	yarn install --non-interactive --frozen-lockfile

.PHONY: clean
clean:
	rm -rf .nyc_output/
	rm -rf lib/
	rm -rf reports/

.PHONY: distclean
distclean: clean
	rm -rf node_modules/
