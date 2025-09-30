exports.up = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.boolean("record_video").defaultTo(false);
        table.text("test_commands").defaultTo("");
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.dropColumn("record_video");
        table.dropColumn("test_commands");
    });
};
