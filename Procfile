# test: export FLASK_APP="./build/flask_test.py" && flask run --extra-files "./build/index.html:./build/TemplateData/scripts/main.js"
web: gunicorn --chdir build flask_test:app
